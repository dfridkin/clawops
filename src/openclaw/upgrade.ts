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
