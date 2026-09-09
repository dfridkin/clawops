// Upgrading the gateway safely: snapshot, check, swap, gate, roll back.
//
// `clawops gateway update` was pull → run → report success. `docker run` exiting 0 means
// the container was created, not that the gateway started — and the container it replaced
// is already gone by then. WO-44 gave us a probe that can actually fail; this gives the
// update something to do when it does.
//
// The SQLite state is the part that cannot be recreated. OpenClaw 2.0 keeps sessions,
// transcripts and credentials there, and a release that does not understand the schema is
// how a database gets damaged rather than merely unread.

/** `openclaw database preflight --json`, as observed on 2026.9.2. */
export interface PreflightReport {
  targetVersion?: number | null
  foundVersion?: number | null
  status?: string
  reason?: string
  issues?: unknown[]
}

export type UpgradeVerdict =
  | { ok: true; note?: string }
  | { ok: false; reason: string }

/**
 * Decide whether the target release may take over this database.
 *
 * The rule is `foundVersion > targetVersion` → refuse: the database was written by a newer
 * release than the one about to run, so the older binary would be reading a schema from its
 * future.
 *
 * **Not demonstrated against real releases.** The state schema has been `userVersion: 15`
 * across every 2.x image checked (2026.8.1, 2026.9.1, 2026.9.2), so no released pair
 * exercises the rejection — it is unit-tested against synthetic reports instead. The guard
 * exists before it is needed, which is the point of a guard, but it has not been proven by
 * observation and should not be described as if it had.
 */
export function judgePreflight(report: PreflightReport): UpgradeVerdict {
  const { targetVersion, foundVersion, status, reason } = report

  if (status === 'indeterminate') {
    return {
      ok: false,
      reason:
        reason ??
        'the database schema could not be determined, so compatibility with the target ' +
          'release is unknown',
    }
  }

  if (typeof foundVersion === 'number' && typeof targetVersion === 'number') {
    if (foundVersion > targetVersion) {
      return {
        ok: false,
        reason:
          `the state database is at schema ${foundVersion}, but the target release ` +
          `understands ${targetVersion}. This is a downgrade across a schema boundary: the ` +
          `older release would read a database written by a newer one. Restore a backup ` +
          `taken before the upgrade instead.`,
      }
    }
    if (foundVersion < targetVersion) {
      return { ok: true, note: `state will migrate from schema ${foundVersion} to ${targetVersion}` }
    }
    return { ok: true }
  }

  // A snapshot with no readable version is not evidence of safety.
  return {
    ok: false,
    reason: reason ?? `preflight returned no schema version (status: ${status ?? 'unknown'})`,
  }
}

/** Parse `database preflight --json`, tolerating a non-JSON failure. */
export function parsePreflight(stdout: string): PreflightReport | undefined {
  try {
    const parsed = JSON.parse(stdout.trim()) as unknown
    if (parsed !== null && typeof parsed === 'object') return parsed as PreflightReport
  } catch {
    /* fall through */
  }
  return undefined
}

/**
 * Snapshot command.
 *
 * `backup sqlite create` produces a CONSOLIDATED snapshot — preflight refuses a live
 * database, because the schema version lives in the WAL until checkpointed:
 *
 *   "SQLite preflight requires a consolidated snapshot with no sidecars; found -wal, -shm."
 *
 * So the backup is not merely a safety net here; it is what makes the check possible.
 */
export function snapshotCommand(image: string, stateDir: string, repo: string): string {
  return (
    `docker run --rm -v ${stateDir}:/home/node/.openclaw ${image} ` +
    `openclaw backup sqlite create --global --repository ${repo} --json`
  )
}

/** Preflight a snapshot with the TARGET image — the release about to take over. */
export function preflightCommand(targetImage: string, stateDir: string, snapshotDb: string): string {
  return (
    `docker run --rm -v ${stateDir}:/home/node/.openclaw ${targetImage} ` +
    `openclaw database preflight ${snapshotDb} --json`
  )
}

/** Extract the snapshot directory from `backup sqlite create --json`. */
export function snapshotPathFrom(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout.trim()) as { ok?: boolean; snapshotPath?: string }
    if (parsed.ok === true && typeof parsed.snapshotPath === 'string') return parsed.snapshotPath
  } catch {
    /* fall through */
  }
  return undefined
}

/**
 * One-shot repair, run in a THROWAWAY container rather than via `docker exec`.
 *
 * `docker exec` needs a running container, and the case this exists for is a gateway that
 * failed to start — often crash-looping, where exec races the restart. A one-shot container
 * mounting the same state directory can repair it whether or not the gateway is up.
 *
 * SP-07 found a real 1.x→2.0 migration needed no repair at all, so this is the exceptional
 * path, not a routine step: it runs only after the startup gate has already failed.
 */
export function repairCommand(image: string, stateDir: string): string {
  // NOT `--json`: the CLI refuses that combination outright —
  //   "doctor --json runs read-only lint checks and cannot be combined with
  //    --repair, --fix, or --force."
  // Shipped as `--fix --json` in the first cut of WO-45, which meant the repair step could
  // only ever fail. The fake in the unit tests returns success for any command, so nothing
  // noticed until this was run against the real image.
  //
  // `--non-interactive --yes` because provisioning has no TTY to answer prompts on. The
  // exit code is deliberately ignored by the caller: doctor exits 1 on advisories
  // ("Memory system not found in workspace") that are not failures of the repair.
  return (
    `docker run --rm -v ${stateDir}:/home/node/.openclaw ${image} ` +
    `openclaw doctor --fix --non-interactive --yes`
  )
}

/** What an upgrade attempt ended up doing, for reporting and for tests. */
export type UpgradeOutcome =
  | { kind: 'started' }
  | { kind: 'repaired' }
  | { kind: 'rolled-back'; to: string; reason: string }
  | { kind: 'failed'; reason: string; snapshotPath: string }

/**
 * Human summary of an upgrade outcome.
 *
 * Kept beside the state machine so the message and the branch cannot drift, and so the
 * failure text is testable without standing up a gateway.
 */
export function describeOutcome(o: UpgradeOutcome, version: string): string {
  switch (o.kind) {
    case 'started':
      return `Gateway updated to ${version}.`
    case 'repaired':
      return `Gateway updated to ${version} after a one-shot repair (doctor --fix).`
    case 'rolled-back':
      return (
        `Rolled back to ${o.to}: the gateway did not start on ${version} — ${o.reason}. ` +
        `The previous image is running again. If it also fails, restore the snapshot taken ` +
        `before the upgrade.`
      )
    case 'failed':
      return (
        `Upgrade to ${version} failed and the rollback did not come up either — ${o.reason}. ` +
        `The state snapshot taken before the upgrade is at ${o.snapshotPath}; restore it ` +
        `with \`openclaw backup sqlite restore\` before retrying.`
      )
  }
}

export interface UpgradeSteps {
  /** Poll until the gateway reports started, or give up. */
  gate: () => Promise<{ ok: boolean; reason?: string }>
  /** One-shot `doctor --fix` in a throwaway container. */
  repair: () => Promise<void>
  /** (Re)create the gateway container on a given version. */
  run: (version: string) => Promise<void>
}

/**
 * What an upgrade does after the container has been created.
 *
 * Extracted from the CLI so the branch that matters — did not start → repair → still did
 * not start → roll back — is testable without a fake SSH session or a 30-second timer. The
 * CLI supplies the three effects; this decides the order and the outcome.
 */
export async function resolveUpgrade(
  steps: UpgradeSteps,
  ctx: { version: string; previousVersion?: string; snapshotPath: string },
): Promise<UpgradeOutcome> {
  const first = await steps.gate()
  if (first.ok) return { kind: 'started' }

  // One shot, not a retry loop: SP-07 found a real 1.x→2.0 migration needed no repair at
  // all, so repeated repair attempts would be thrashing a deployment that has some other
  // problem.
  await steps.repair()
  await steps.run(ctx.version)
  const second = await steps.gate()
  if (second.ok) return { kind: 'repaired' }

  const reason = second.reason ?? first.reason ?? 'unknown'
  if (!ctx.previousVersion) return { kind: 'failed', reason, snapshotPath: ctx.snapshotPath }

  await steps.run(ctx.previousVersion)
  const back = await steps.gate()
  return back.ok
    ? { kind: 'rolled-back', to: ctx.previousVersion, reason }
    : { kind: 'failed', reason, snapshotPath: ctx.snapshotPath }
}
