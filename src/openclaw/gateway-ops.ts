// What `clawops gateway status` and `clawops gateway update` do, for both surfaces.
//
// The CLI and the MCP server both run these, and an agent driving clawops must get the same
// answers and the same refusals an operator does — the refusals are the feature. Nothing here
// prints: it returns a result, and reports progress through callbacks. Spinners, exit codes and
// tables belong to the CLI; elicitation and text results belong to the MCP handler (R15 also
// forbids a stdio server writing a byte to stdout).

import { type Result, ok, err } from '../types/result.js'
import { execPrivileged } from '../transport/privileged.js'
import type { SshSession } from '../transport/ssh.js'
import { inspectContainer } from './docker.js'
import { IMAGE_INSPECT_CMD, imageForRestart, versionOf, GATEWAY_PORT } from './run-flags.js'
import {
  gatewayRunCommand, PUBLISH_INSPECT_CMD, publishForRestart, STATE_DIR_HOST_LINUX, STATE_DIR_CONTAINER,
} from './runtime.js'
import {
  snapshotCommand, snapshotPathFrom, preflightCommand, parsePreflight, judgePreflight,
  repairCommand, describeOutcome, resolveUpgrade, type UpgradeOutcome,
} from './upgrade.js'
import { probeCommand, interpretProbe } from './health.js'

/** Shared docker stop → rm → run command for a gateway on `version`. */
export function dockerRunCmd(version: string, publish: 'loopback' | 'all' = 'loopback'): string {
  return gatewayRunCommand({
    image: `ghcr.io/openclaw/openclaw:${version}`,
    stateDir: STATE_DIR_HOST_LINUX,
    publish,
  })
}

// ── status ──────────────────────────────────────────────────────────────────

export interface GatewayStatus { status: string; started: string; image: string }

const STATUS_FORMAT =
  '{"status":"{{.State.Status}}","started":"{{.State.StartedAt}}","image":"{{.Config.Image}}"}'

/**
 * The gateway container as docker reports it.
 *
 * A missing container is an answer ("not running"). Docker being unreachable is not: reporting
 * "not running" there would be a statement about the gateway, when the truth is that clawops
 * could not ask. That case is an error, never a status.
 */
export async function gatewayStatus(
  session: SshSession,
  signal?: AbortSignal,
): Promise<Result<GatewayStatus, string>> {
  const inspected = await inspectContainer(session, 'openclaw', STATUS_FORMAT, signal)
  if (inspected.kind === 'missing') return ok({ status: 'not running', started: '', image: '' })
  if (inspected.kind === 'error') {
    return err(`Could not ask docker about the gateway: ${inspected.detail}`)
  }
  try {
    return ok(JSON.parse(inspected.value) as GatewayStatus)
  } catch {
    return ok({ status: 'unknown', started: '', image: '' })
  }
}

// ── update ──────────────────────────────────────────────────────────────────

/**
 * The version an update moves to, checked BEFORE anything reaches the host.
 *
 * `update` is the one path that changes the deployed version. A pre-2.0 release pulled onto a
 * host running the 2.0 contract, or a moving tag handed straight to `docker pull` and resolved
 * by the registry after every check clawops could make, is how an unsupported release reaches
 * a deployment. Guarding after the pull would be guarding after the damage.
 *
 * No version requested = the recommended pin from spec/openclaw-versions.yaml, never a tag.
 */
export async function resolveUpdateVersion(
  requested: string | undefined,
): Promise<Result<string, string>> {
  const yaml = await import('js-yaml')
  const { assertSupportedVersion, loadVersionSpec } = await import('./versions.js')
  if (!requested) return ok(loadVersionSpec(yaml).support.recommended)
  const result = await assertSupportedVersion(requested, yaml)
  return result.ok ? ok(result.value) : err(result.error.message)
}

/** The version the host runs now, if docker can say. Read-only; used to describe an update. */
export async function currentGatewayVersion(
  session: SshSession,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const cur = imageForRestart((await execPrivileged(session, IMAGE_INSPECT_CMD, signal)).stdout)
  return cur.ok ? versionOf(cur.value) : undefined
}

export interface UpdateHooks {
  /** What the update is doing now. The CLI shows it on its spinner. */
  onProgress?: (text: string) => void
  /** Something worth saying that is not a failure (a preflight note). */
  onNote?: (text: string) => void
  signal?: AbortSignal
  /** Wait between startup probes. Injectable so tests need not sleep. */
  sleep?: (ms: number) => Promise<void>
}

export type UpdateResult =
  | { ok: true; version: string; previousVersion?: string; outcome: UpgradeOutcome; message: string }
  | {
      ok: false
      version: string
      /** The failure, in the words both surfaces report. */
      message: string
      /** Where to go from here — e.g. the snapshot taken before the upgrade. */
      hint?: string
      outcome?: UpgradeOutcome
    }

/**
 * Pull `version`, prove the state is compatible, replace the container, and wait for it to
 * start — repairing once, then rolling back, if it does not.
 *
 * `version` must already have passed `resolveUpdateVersion`.
 */
export async function updateGateway(
  session: SshSession,
  version: string,
  hooks: UpdateHooks = {},
): Promise<UpdateResult> {
  const { signal } = hooks
  const progress = hooks.onProgress ?? (() => {})
  const sleep = hooks.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)))
  const targetImage = `ghcr.io/openclaw/openclaw:${version}`

  const pullResult = await execPrivileged(session, `docker pull ${targetImage}`, signal)
  if (pullResult.code !== 0) {
    return { ok: false, version, message: `Pull failed: ${pullResult.stderr}` }
  }

  // Snapshot, then ask the TARGET release whether it understands this database. The snapshot
  // is not only a rollback point: preflight refuses a live database, because the schema
  // version sits in the WAL until checkpointed.
  progress('Checking state compatibility...')
  const cur = imageForRestart((await execPrivileged(session, IMAGE_INSPECT_CMD, signal)).stdout)
  const previousVersion = cur.ok ? versionOf(cur.value) : undefined
  // The snapshot runs inside a container, so its repository is a path in the container: the
  // state directory is mounted at STATE_DIR_CONTAINER. This passed the HOST path, which does
  // not exist in there and which the container's user cannot create, so every update since
  // WO-45 refused at this step with "EACCES during mkdir". Unit tests answer any command with
  // success; the local MCP e2e is what ran it.
  const snapRepo = `${STATE_DIR_CONTAINER}/snapshots`
  const snapOut = await execPrivileged(
    session,
    snapshotCommand(cur.ok ? cur.value : targetImage, STATE_DIR_HOST_LINUX, snapRepo),
    signal,
  )
  const snapPath = snapshotPathFrom(snapOut.stdout)
  // Where an operator finds it: the same directory, seen from the host.
  const hostSnapPath = snapPath?.startsWith(STATE_DIR_CONTAINER)
    ? STATE_DIR_HOST_LINUX + snapPath.slice(STATE_DIR_CONTAINER.length)
    : snapPath

  if (!snapPath) {
    // No snapshot means no compatibility check and no rollback point. Refuse rather than
    // replace a working container on the strength of a `docker run` exit code.
    return {
      ok: false,
      version,
      message:
        'Could not snapshot the state database before upgrading, so neither the ' +
        'compatibility check nor a rollback point is available.\n' +
        (snapOut.stderr || snapOut.stdout).slice(0, 2000),
    }
  }

  const pre = await execPrivileged(
    session,
    preflightCommand(targetImage, STATE_DIR_HOST_LINUX, `${snapPath}/database.sqlite`),
    signal,
  )
  const report = parsePreflight(pre.stdout)
  const verdict = report
    ? judgePreflight(report)
    : { ok: false as const, reason: `preflight produced no readable report: ${pre.stderr.slice(0, 200)}` }

  if (!verdict.ok) {
    return {
      ok: false,
      version,
      message: `Refusing to upgrade to ${version}: ${verdict.reason}`,
      hint: `A snapshot of the current state was kept at ${hostSnapPath}.`,
    }
  }
  if (verdict.note) hooks.onNote?.(verdict.note)
  progress(`Updating gateway to ${version}...`)

  // An update changes the version by request; it must not also change who can reach the
  // gateway.
  const pubU = await execPrivileged(session, PUBLISH_INSPECT_CMD, signal)
  const publish = publishForRestart(pubU.stdout)
  const runResult = await execPrivileged(session, dockerRunCmd(version, publish), signal)
  if (runResult.code !== 0) {
    return {
      ok: false,
      version,
      message: `Start failed: ${runResult.stderr}`,
      hint: `State snapshot from before the upgrade: ${hostSnapPath}`,
    }
  }

  // `docker run` exiting 0 means the container was created. Whether the gateway STARTED is a
  // different question, and it is the one that matters here — the container this replaced is
  // already gone.
  progress('Waiting for the gateway to start...')

  const gate = async (): Promise<{ ok: boolean; reason?: string }> => {
    let last: string | undefined
    for (let i = 0; i < 15; i++) {
      if (signal?.aborted) return { ok: false, reason: 'aborted' }
      const r = await execPrivileged(session, probeCommand('started', GATEWAY_PORT), signal)
      const v = interpretProbe('started', r.stdout)
      if (v.ok) return { ok: true }
      last = v.reason
      await sleep(2000)
    }
    return { ok: false, reason: last ?? 'no response' }
  }

  const outcome = await resolveUpgrade(
    {
      gate,
      repair: async () => {
        progress('Gateway did not start; attempting one-shot repair...')
        await execPrivileged(session, repairCommand(targetImage, STATE_DIR_HOST_LINUX), signal)
      },
      run: async (v) => {
        await execPrivileged(session, dockerRunCmd(v, publish), signal)
      },
    },
    { version, previousVersion, snapshotPath: hostSnapPath ?? snapPath },
  )

  const message = describeOutcome(outcome, version)
  if (outcome.kind === 'started' || outcome.kind === 'repaired') {
    return { ok: true, version, ...(previousVersion ? { previousVersion } : {}), outcome, message }
  }
  return { ok: false, version, message, outcome }
}
