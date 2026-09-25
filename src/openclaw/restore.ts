// Putting a restored backup into service.
//
// `clawops backup restore` verifies an archive and expands it, and then stopped: it printed three
// manual steps and left the operator to perform the middle one — a move over live state, by hand,
// over SSH, at the moment they can least afford to mistype it.
//
// Two things make that safe to automate. The first is that every move here is a rename inside one
// directory, so activation is three renames rather than a copy: it is fast, it needs no extra
// disk, and a rename either happens or does not. The second is that the state being replaced is
// moved aside rather than deleted. A restore that destroys what it replaces is not an improvement
// on the manual procedure; it just makes the mistake faster and unrecoverable.
//
// Staging lives under the state directory because that is the one path the container and the host
// both see. It used to be the container's own /tmp, which the host cannot reach and which
// `gateway restart` destroys — it stops, removes and re-runs the container — so a restore left
// there could evaporate at the next step of the very procedure that was meant to adopt it.

export type RestoreExec = (command: string) => Promise<{ stdout: string; stderr: string; code: number }>

/**
 * The layout OpenClaw's restore actually produces, which is a bundle rather than a state
 * directory:
 *
 *   <target>/<archiveRoot>/manifest.json
 *   <target>/<archiveRoot>/payload/posix/<the state directory at its original absolute path>
 *
 * Moving `<target>` into place gives the gateway a manifest.json where its config should be, and
 * it refuses to start — which is what a live host demonstrated. The state to adopt is the subtree
 * under `payload/posix`, at the path the manifest records.
 *
 * This is upstream's format, so clawops reads the schemaVersion and refuses one it has not been
 * tested against. A restore that half-understands the archive is worse than one that declines.
 */
export const SUPPORTED_MANIFEST_SCHEMA = 1

export type LocatedState =
  | { ok: true; statePath: string; stateDirInArchive: string }
  | { ok: false; reason: string }

/** Where the adoptable state sits inside a restored bundle, according to its manifest. */
export function locateRestoredState(manifestJson: string, bundleRoot: string): LocatedState {
  let manifest: { schemaVersion?: unknown; archiveRoot?: unknown; paths?: { stateDir?: unknown } }
  try {
    manifest = JSON.parse(manifestJson) as typeof manifest
  } catch {
    return { ok: false, reason: 'The restored archive has no readable manifest.json.' }
  }

  if (manifest.schemaVersion !== SUPPORTED_MANIFEST_SCHEMA) {
    return {
      ok: false,
      reason:
        `This archive declares manifest schemaVersion ${String(manifest.schemaVersion)}, and clawops ` +
        `has only been tested against ${SUPPORTED_MANIFEST_SCHEMA}. Its layout may have changed, so ` +
        'clawops will not move it into place. The archive is expanded and can be adopted by hand.',
    }
  }

  const archiveRoot = typeof manifest.archiveRoot === 'string' ? manifest.archiveRoot : ''
  const stateDir = typeof manifest.paths?.stateDir === 'string' ? manifest.paths.stateDir : ''
  if (!archiveRoot || !stateDir) {
    return { ok: false, reason: 'The manifest names no archiveRoot or stateDir, so clawops cannot tell which directory to adopt.' }
  }

  // payload/posix mirrors the original absolute path, so the leading slash is dropped rather
  // than joined — `${a}/${b}` with an absolute b would otherwise escape the bundle entirely.
  return {
    ok: true,
    stateDirInArchive: stateDir,
    statePath: `${bundleRoot}/${archiveRoot}/payload/posix/${stateDir.replace(/^\/+/, '')}`,
  }
}

export interface ActivateOpts {
  /** Host path of the live state directory, e.g. /var/lib/clawops/openclaw. */
  stateDir: string
  /** Host path of the expanded archive, under stateDir. */
  staging: string
  /** Privileged command runner on the host. */
  exec: RestoreExec
  /** Stop, remove and re-run the gateway container. */
  restart: () => Promise<void>
  /** Resolve when the gateway answers; throw or reject when it does not. */
  waitHealthy: () => Promise<void>
  now?: () => number
}

export type ActivateOutcome =
  | { ok: true; preserved: string }
  | { ok: false; reason: string; rolledBack: boolean; preserved?: string; keptFailed?: string }

/** A rename that reports its own failure rather than leaving the caller to infer it. */
async function move(exec: RestoreExec, from: string, to: string): Promise<string | null> {
  const r = await exec(`mv ${shellArg(from)} ${shellArg(to)}`)
  if (r.code === 0) return null
  return (r.stderr || r.stdout).trim().split('\n').slice(-1)[0] || `mv exited ${r.code}`
}

/**
 * Swap the restored state in, and put the old state back if the gateway does not come up.
 *
 * The order matters. Staging moves out of the state directory first, because the next step
 * renames that directory and would carry staging along with it.
 */
export async function activateRestored(opts: ActivateOpts): Promise<ActivateOutcome> {
  const { stateDir, staging, exec, restart, waitHealthy } = opts
  const stamp = new Date(opts.now?.() ?? Date.now()).toISOString().replace(/[:.]/g, '-')
  const parent = stateDir.replace(/\/+$/, '').replace(/\/[^/]+$/, '') || '/'
  const preserved = `${stateDir}.pre-restore-${stamp}`
  const holding = `${parent}/.clawops-restored-${stamp}`

  const exists = await exec(`test -d ${shellArg(staging)} && echo yes || echo no`)
  if (exists.stdout.trim() !== 'yes') {
    return { ok: false, reason: `The restored archive is not at ${staging}.`, rolledBack: false }
  }

  const outFirst = await move(exec, staging, holding)
  if (outFirst) {
    return { ok: false, reason: `Could not move the restored state clear of the live directory: ${outFirst}`, rolledBack: false }
  }

  const asideErr = await move(exec, stateDir, preserved)
  if (asideErr) {
    // Nothing has been replaced; put staging back so a retry finds it where it was.
    await move(exec, holding, staging)
    return { ok: false, reason: `Could not set the current state aside: ${asideErr}`, rolledBack: false }
  }

  const inErr = await move(exec, holding, stateDir)
  if (inErr) {
    await move(exec, preserved, stateDir)
    return { ok: false, reason: `Could not move the restored state into place: ${inErr}`, rolledBack: true }
  }

  try {
    await restart()
    await waitHealthy()
    return { ok: true, preserved }
  } catch (err) {
    /*
     * The restored state expanded cleanly and then would not run. Keep it — it is evidence, and
     * the operator may want it — but give the machine back its working state first.
     */
    const keptFailed = `${stateDir}.failed-restore-${stamp}`
    const reason = err instanceof Error ? err.message : String(err)

    const parkErr = await move(exec, stateDir, keptFailed)
    if (parkErr) {
      return {
        ok: false,
        rolledBack: false,
        preserved,
        reason:
          `The gateway did not come up (${reason}), and the restored state could not be moved ` +
          `aside to roll back (${parkErr}). The previous state is at ${preserved}.`,
      }
    }
    const backErr = await move(exec, preserved, stateDir)
    if (backErr) {
      return {
        ok: false,
        rolledBack: false,
        keptFailed,
        reason:
          `The gateway did not come up (${reason}), and the previous state could not be put back ` +
          `(${backErr}). It is at ${preserved}; the restored state is at ${keptFailed}.`,
      }
    }

    await restart().catch(() => undefined)
    return {
      ok: false,
      rolledBack: true,
      keptFailed,
      reason: `The gateway did not come up with the restored state (${reason}). The previous state has been put back.`,
    }
  }
}

/**
 * Whether the filesystem holding `dir` has room for `bytes`.
 *
 * Checked before an archive is expanded, not before the swap: the swap is renames within one
 * directory and needs nothing. Filling the disk of a machine someone is mid-incident on is a
 * worse outcome than refusing early.
 */
export async function hasRoomFor(
  exec: RestoreExec,
  dir: string,
  bytes: number,
): Promise<{ ok: true } | { ok: false; availableBytes: number; neededBytes: number }> {
  const r = await exec(`df -Pk ${shellArg(dir)} | tail -1 | awk '{print $4}'`)
  const availableKb = Number.parseInt(r.stdout.trim(), 10)
  // An unreadable df is not a reason to refuse; the expand will fail honestly if space runs out.
  if (!Number.isFinite(availableKb)) return { ok: true }
  const availableBytes = availableKb * 1024
  return availableBytes >= bytes ? { ok: true } : { ok: false, availableBytes, neededBytes: bytes }
}

/** Single-quote for sh. Paths here are built by clawops, but they carry a timestamp and a mount. */
function shellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
