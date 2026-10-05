// Taking a backup, and bringing one back: the sequence both surfaces run.
//
// `clawops backup` and the clawops_backup_create / clawops_backup_restore tools are one
// implementation behind two surfaces. The sequence lived inline in the CLI command, and an MCP
// handler that re-wrote it would drift from it in exactly the places that matter — the free-space
// refusal, the manifest check, the rollback. So it lives here, and each surface decides only how
// to render what it returns.
//
// Nothing here prints. The CLI's human output helpers can write to stdout, which a stdio MCP
// server must never do (R15), so the flows report phases through a callback and return results;
// the CLI turns those into spinners and lines, the MCP handlers into text. Refusals the operator
// is meant to read come back as `reason` strings, worded once, here, so both surfaces say the
// same thing.

import { createReadStream, createWriteStream, statSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import type { SshSession } from '../transport/ssh.js'
import { execPrivileged, execPrivilegedWithInput, streamPrivileged } from '../transport/privileged.js'
import { CONTAINER_UID, stateDirForOS } from './runtime.js'
import { activateRestored, hasRoomFor, locateRestoredState } from './restore.js'

// ── Shared words ────────────────────────────────────────────────────────────────────────────

/** The archive name both surfaces use when the caller does not name one. */
export function defaultBackupFilename(now: Date = new Date()): string {
  return `openclaw-backup-${now.toISOString().replace(/[:.]/g, '-')}.tar.gz`
}

/** Said after every successful backup. The archive is a credential, and the operator must know. */
export const ARCHIVE_IS_A_CREDENTIAL = [
  'Saved with mode 0600. The archive contains the state database — OAuth tokens,',
  'secrets and device credentials, unencrypted. Treat it as a credential.',
] as const

/** Said after every restore, staged or live: plugins do not travel in the archive. */
export const PLUGINS_NOT_CARRIED = [
  'Provider plugins are not carried in the archive; re-run `clawops apply` to',
  'reinstall them, or the gateway starts without its model providers.',
] as const

/** Said whenever a restore stops after expanding but before touching live state. */
export function nothingChanged(stagingOnHost: string): string {
  return `The expanded archive is at ${stagingOnHost}; nothing has been changed.`
}

/** Bytes as MiB, for a message about disk space someone reads while under pressure. */
function mib(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MiB`
}

// ── Create ──────────────────────────────────────────────────────────────────────────────────

export type CreatePhase = 'creating' | 'downloading'

export interface CreateBackupOpts {
  /** Local path to write the archive to. The caller decides what is acceptable here. */
  outPath: string
  signal?: AbortSignal
  onPhase?: (phase: CreatePhase) => void
}

export type CreateBackupOutcome =
  | { ok: true; path: string }
  | { ok: false; reason: string }

/**
 * Have OpenClaw write a verified archive inside the container, stream it to `outPath`, and
 * remove the remote copy.
 */
export async function createBackup(session: SshSession, opts: CreateBackupOpts): Promise<CreateBackupOutcome> {
  const { outPath, signal } = opts
  opts.onPhase?.('creating')

  // `openclaw backup create` writes to a path; it has no stdout mode. Write it
  // inside the container, stream it out with `docker exec cat`, then clean up.
  // The previous implementation invoked `openclaw-ctl backup create --stdout`:
  // that binary does not exist, and neither does that flag.
  const remoteArchive = '/tmp/clawops-backup.tar.gz'
  const createResult = await execPrivileged(session,
    `docker exec openclaw sh -lc 'rm -f ${remoteArchive} && ` +
      `openclaw backup create --output ${remoteArchive} --verify --json'`,
    signal,
  )
  if (createResult.code !== 0) {
    return { ok: false, reason: `Backup failed on the remote host: ${createResult.stderr.slice(0, 300)}` }
  }

  const backupStream = await streamPrivileged(session, `docker exec openclaw cat ${remoteArchive}`, signal)
  opts.onPhase?.('downloading')
  // 0600, matching the mode OpenClaw gives the archive on the host. The default is
  // 0644, and this archive carries the state database — whose tables include
  // mcp_oauth_stores, secret_store_entries, worker_environment_credentials and
  // device_auth_tokens, unencrypted.
  const fileStream = createWriteStream(outPath, { mode: 0o600 })
  await pipeline(backupStream, fileStream)
  await execPrivileged(session, `docker exec openclaw rm -f ${remoteArchive}`, signal)
  return { ok: true, path: outPath }
}

// ── Restore: verify and stage ───────────────────────────────────────────────────────────────

export type RestorePhase = 'uploading' | 'restoring'

export interface StageRestoreOpts {
  /** Local archive to restore from. */
  file: string
  signal?: AbortSignal
  onPhase?: (phase: RestorePhase) => void
  now?: () => number
}

export interface StagedRestore {
  ok: true
  /** The live state directory on the host. */
  stateDir: string
  /** The expanded bundle on the host, beside the live state. */
  stagingOnHost: string
  /** The adoptable state directory inside the bundle. */
  statePath: string
  /** The state directory's path as the archive recorded it. */
  stateDirInArchive: string
  entryCount?: number
  /** Upstream's warnings, verbatim. */
  warnings: string[]
  /** Upstream's report when it was not the JSON it promised; shown raw rather than dropped. */
  unparsedReport?: string
}

export type StageRestoreOutcome =
  | StagedRestore
  | {
      ok: false
      /**
       * `refused`: clawops declined before changing anything (not enough room).
       * `failed`: a step on the host failed.
       * `unadoptable`: the archive expanded, but clawops will not move it into place.
       */
      kind: 'refused' | 'failed' | 'unadoptable'
      reason: string
      /** Present when the archive was expanded on the host and left there. */
      stagingOnHost?: string
      unparsedReport?: string
    }

/**
 * Upload an archive, have OpenClaw verify and expand it, and copy the result out to the host
 * beside the live state. Live state is not touched.
 *
 * Delegated to OpenClaw, which restores into a FRESH directory and refuses a non-empty target
 * ("Backup restore target directory must be empty"). clawops does not extract archives itself
 * and does not restore in place: writing an archive over a live state directory is how a backup
 * becomes corruption, and upstream already enforces the safe shape.
 */
export async function stageRestore(session: SshSession, opts: StageRestoreOpts): Promise<StageRestoreOutcome> {
  const { file, signal } = opts
  const remoteArchive = '/tmp/clawops-restore.tar.gz'
  const stamp = (opts.now ?? Date.now)()
  /*
   * Expanded in the container, then copied out to the host.
   *
   * OpenClaw refuses a target inside the live state directory — "Backup restore target must
   * be outside the live OpenClaw state directory" — which rules out staging somewhere the
   * bind mount already exposes. And the container's own /tmp does not survive
   * `gateway restart`, which stops, removes and re-runs the container, so a restore left
   * there could evaporate at the next step of the procedure meant to adopt it.
   *
   * `docker cp` bridges the two: upstream expands where it insists, and the copy that the
   * operator is asked to trust lives on the host, beside the state directory it will
   * replace and on the same filesystem, so activation stays a rename.
   */
  const stagingInContainer = `/tmp/clawops-restored-${stamp}`

  const hostExec = (command: string) => execPrivileged(session, command, signal)
  const osProbe = await session.exec('uname -s', signal)
  const stateDir = stateDirForOS(osProbe.stdout.trim() === 'Darwin' ? 'Darwin' : 'Linux')
  const stateParent = stateDir.replace(/\/+$/, '').replace(/\/[^/]+$/, '') || '/'
  const stagingOnHost = `${stateParent}/.clawops-restored-${stamp}`

  // Expanding needs room for the archive and its contents; the swap afterwards is renames
  // inside one directory and needs none.
  const archiveBytes = statSync(file).size
  const room = await hasRoomFor(hostExec, stateDir, archiveBytes * 3)
  if (!room.ok) {
    return {
      ok: false,
      kind: 'refused',
      reason:
        `Not enough free space on the host to expand this archive: ${mib(room.availableBytes)} ` +
        `available where the state lives, and the restore needs about ${mib(room.neededBytes)}. ` +
        'Free some space and run this again; nothing has been changed.',
    }
  }

  opts.onPhase?.('uploading')
  const uploadResult = await execPrivilegedWithInput(
    session,
    `docker exec -i openclaw sh -c 'cat > ${remoteArchive}'`,
    createReadStream(file),
    signal,
  )
  if (uploadResult.code !== 0) {
    return { ok: false, kind: 'failed', reason: `Could not upload the archive: ${uploadResult.stderr.slice(0, 300)}` }
  }

  opts.onPhase?.('restoring')
  const restore = await execPrivileged(
    session,
    `docker exec openclaw openclaw backup restore ${remoteArchive} --target ${stagingInContainer} --json`,
    signal,
  )
  await execPrivileged(session, `docker exec openclaw rm -f ${remoteArchive}`, signal)

  if (restore.code !== 0) {
    return { ok: false, kind: 'failed', reason: `Restore failed: ${(restore.stderr || restore.stdout).slice(0, 400)}` }
  }

  // Out of the container before anything else touches it, so what the operator is pointed
  // at cannot be destroyed by a container restart.
  const copyOut = await hostExec(`docker cp openclaw:${stagingInContainer} ${stagingOnHost}`)
  await execPrivileged(session, `docker exec openclaw rm -rf ${stagingInContainer}`, signal)
  if (copyOut.code !== 0) {
    return {
      ok: false,
      kind: 'failed',
      reason:
        `The archive was restored inside the container but could not be copied to the host: ` +
        `${(copyOut.stderr || copyOut.stdout).slice(0, 300)}`,
    }
  }

  let report: { entryCount?: number; warnings?: string[] } = {}
  let unparsedReport: string | undefined
  try {
    report = JSON.parse(restore.stdout.trim()) as typeof report
  } catch {
    unparsedReport = restore.stdout
  }

  /*
   * What upstream produced is a bundle, not a state directory: manifest.json beside a
   * payload tree that mirrors the original absolute path. Moving the bundle into place
   * gives the gateway a manifest where its config should be, and it will not start.
   */
  const manifestRead = await hostExec(`cat ${stagingOnHost}/*/manifest.json`)
  const located = locateRestoredState(manifestRead.stdout, stagingOnHost)
  if (!located.ok) {
    return {
      ok: false,
      kind: 'unadoptable',
      reason: located.reason,
      stagingOnHost,
      ...(unparsedReport !== undefined ? { unparsedReport } : {}),
    }
  }

  return {
    ok: true,
    stateDir,
    stagingOnHost,
    statePath: located.statePath,
    stateDirInArchive: located.stateDirInArchive,
    ...(report.entryCount !== undefined ? { entryCount: report.entryCount } : {}),
    warnings: report.warnings ?? [],
    ...(unparsedReport !== undefined ? { unparsedReport } : {}),
  }
}

// ── Restore: put into service ───────────────────────────────────────────────────────────────

export type ActivatePhase = 'activating' | 'restarting' | 'waiting' | 'done'

export interface ActivateStagedOpts {
  signal?: AbortSignal
  onPhase?: (phase: ActivatePhase) => void
}

export type ActivateStagedOutcome =
  | { ok: true; preserved: string }
  | {
      ok: false
      reason: string
      /** Present when nothing live was changed and the expanded archive is still staged. */
      stagingOnHost?: string
      keptFailed?: string
      preserved?: string
    }

/**
 * Stop the gateway, swap the staged state in (keeping what it replaces), restart, and roll
 * back if the gateway does not answer.
 */
export async function activateStaged(
  session: SshSession,
  staged: StagedRestore,
  opts: ActivateStagedOpts = {},
): Promise<ActivateStagedOutcome> {
  const { signal } = opts
  const hostExec = (command: string) => execPrivileged(session, command, signal)
  const { restartGateway } = await import('../plan/remote-config.js')
  const { waitForGateway } = await import('./ready.js')

  opts.onPhase?.('activating')
  /*
   * `docker exec` runs as root, so everything upstream wrote is root-owned; the gateway
   * runs as the container user and cannot read its own state that way.
   */
  const chown = await hostExec(`chown -R ${CONTAINER_UID}:${CONTAINER_UID} ${staged.statePath}`)
  if (chown.code !== 0) {
    opts.onPhase?.('done')
    return {
      ok: false,
      reason: `Could not give the restored state to the gateway's user: ${(chown.stderr || chown.stdout).slice(0, 200)}`,
      stagingOnHost: staged.stagingOnHost,
    }
  }

  const outcome = await activateRestored({
    stateDir: staged.stateDir,
    staging: staged.statePath,
    exec: hostExec,
    restart: async () => {
      opts.onPhase?.('restarting')
      await restartGateway(session, signal)
    },
    waitHealthy: async () => {
      opts.onPhase?.('waiting')
      /*
       * Three minutes, not the ten a deploy allows. This runs during an incident, on a
       * gateway that was answering a minute ago, and every second past "it is not coming
       * up" is a second before the previous state goes back.
       */
      await waitForGateway(session, { ...(signal ? { signal } : {}), timeoutMs: 180_000 })
    },
  })
  opts.onPhase?.('done')

  if (!outcome.ok) {
    return {
      ok: false,
      reason: outcome.reason,
      ...(outcome.keptFailed ? { keptFailed: outcome.keptFailed } : {}),
      ...(outcome.preserved ? { preserved: outcome.preserved } : {}),
    }
  }

  // The bundle wrapper is a copy, and the part worth keeping has moved out of it.
  await hostExec(`rm -rf ${staged.stagingOnHost}`)
  return { ok: true, preserved: outcome.preserved }
}

/** The lines that follow a failed activation, on either surface. */
export function activationFailureDetail(outcome: Extract<ActivateStagedOutcome, { ok: false }>): string[] {
  const lines: string[] = []
  if (outcome.stagingOnHost) lines.push(nothingChanged(outcome.stagingOnHost))
  if (outcome.keptFailed) lines.push(`The restored state was kept at ${outcome.keptFailed}.`)
  if (outcome.preserved) lines.push(`The previous state is at ${outcome.preserved}.`)
  return lines
}

/** The lines that follow a successful activation, on either surface. */
export function activatedLines(preserved: string): string[] {
  return [
    `The state it replaced is at ${preserved}.`,
    'Remove that directory once you are satisfied; clawops will not.',
    ...PLUGINS_NOT_CARRIED,
  ]
}

export const ACTIVATED = 'The restored state is live and the gateway is answering.'
