// Shared SSH helpers for reading/writing openclaw.json on a remote host.
// Used by apply.ts (cloud post-provisioning) and up.ts (local --config).
// Extracted so the MCP config handler and plan layer share one implementation.

import type { SshSession } from '../transport/ssh.js'
import { GATEWAY_PORT, IMAGE_INSPECT_CMD, imageForRestart } from '../openclaw/run-flags.js'
import { execPrivileged } from '../transport/privileged.js'
import {
  gatewayRunCommand, PUBLISH_INSPECT_CMD, publishForRestart,
  configPathForOS, stateDirForOS, CONTAINER_UID,
} from '../openclaw/runtime.js'

// Re-exported from runtime.ts, which owns these now. Before WO-39 the path was defined
// five times across three TS files and two shell templates.
export const OPENCLAW_CONFIG_LINUX = configPathForOS('Linux')
export const OPENCLAW_CONFIG_MACOS = configPathForOS('Darwin')
export const OPENCLAW_CONFIG = OPENCLAW_CONFIG_LINUX  // kept for back-compat
export const OPENCLAW_TMP = '/tmp/clawops-config.json.tmp'

async function detectOS(session: SshSession, signal?: AbortSignal): Promise<'Linux' | 'Darwin'> {
  const result = await session.exec('uname -s', signal)
  return result.stdout.trim() === 'Darwin' ? 'Darwin' : 'Linux'
}


/** Read and parse openclaw.json from the remote host. */
export async function readRemoteConfig(
  session: SshSession,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const os = await detectOS(session, signal)
  const configPath = configPathForOS(os)
  // On Linux the SSH user may differ from the 'clawops' owner (e.g. AWS 'ubuntu').
  // Fall back to sudo -n so the read succeeds regardless of file permissions.
  const result = os === 'Darwin'
    ? await session.exec(`cat ${configPath}`, signal)
    : await execPrivileged(session, `cat ${configPath}`, signal)
  if (result.code !== 0) {
    throw new Error(`Cannot read ${configPath}: ${result.stderr}`)
  }
  try {
    return JSON.parse(result.stdout) as Record<string, unknown>
  } catch {
    throw new Error(`Cannot parse ${configPath}: invalid JSON`)
  }
}

/**
 * Force `gateway.port` to the port clawops publishes.
 *
 * Config delivery was broken until v1.7.2, so a non-default port in a stored config
 * has never taken effect — there is no working behaviour to preserve, only a dormant
 * value that would now move the listener away from the `-p` mapping. Returns the
 * previous value when it changed, so the caller can say so rather than silently
 * rewriting the user's file.
 */
export function normaliseGatewayPort(cfg: Record<string, unknown>): number | undefined {
  const gateway = cfg['gateway']
  if (!gateway || typeof gateway !== 'object' || Array.isArray(gateway)) return undefined
  const g = gateway as Record<string, unknown>
  const current = g['port']
  if (typeof current === 'number' && current !== GATEWAY_PORT) {
    g['port'] = GATEWAY_PORT
    return current
  }
  if (current === undefined) g['port'] = GATEWAY_PORT
  return undefined
}

/** Atomically write a config object to the remote openclaw.json. */
export interface WriteConfigOpts {
  /** The OpenClaw version this config is for, so validation can judge unknown keys. */
  openclawVersion?: string
  /** Skip validation. For callers writing a config the schema cannot describe. */
  skipValidation?: boolean
}

export async function atomicWriteConfig(
  session: SshSession,
  cfg: Record<string, unknown>,
  signal?: AbortSignal,
  opts: WriteConfigOpts = {},
): Promise<void> {
  const os = await detectOS(session, signal)
  const configPath = configPathForOS(os)
  const json = JSON.stringify(cfg, null, 2)

  // Validate BEFORE the write, not after. A config that fails validation is one the
  // gateway may refuse to start on, and the restart that follows a write is where that
  // surfaces — by which point the previous good config is gone.
  if (!opts.skipValidation) {
    const [{ validateConfig }, yaml] = await Promise.all([
      import('../openclaw/config-validate.js'),
      import('js-yaml'),
    ])
    const { loadVersionSpec } = await import('../openclaw/versions.js')
    const spec = loadVersionSpec(yaml)
    const { errors, warnings } = await validateConfig(cfg, {
      openclawVersion: opts.openclawVersion,
      schemaCapturedFrom: spec.runtime?.configSchemaCapturedFrom,
    })
    for (const w of warnings) process.stderr.write(`warning: ${w}\n`)
    if (errors.length > 0) {
      // Keep what was rejected. Losing the operator's intended config to a validation
      // failure would make the check worse than not having one.
      const rejected = `${configPath}.rejected.${new Date().toISOString().replace(/[:.]/g, '-')}`
      const b64r = Buffer.from(json, 'utf-8').toString('base64')
      await execPrivileged(session, `echo '${b64r}' | base64 -d > ${rejected}`, signal)
      throw new Error(
        `Refusing to write an invalid OpenClaw config:\n` +
          errors.map((e) => `  - ${e}`).join('\n') +
          `\nThe rejected config was kept at ${rejected}. ` +
          `The deployment's current config is unchanged.`,
      )
    }
  }
  const b64 = Buffer.from(json, 'utf-8').toString('base64')
  // Numeric, never `clawops:clawops`. On Ubuntu 24.04 `useradd clawops` gets uid 1001
  // while the container runs as 1000, and the gateway then exits 1 with EACCES on its
  // own SQLite WAL. Verified on a native Linux bind mount — SP-11 §C. (G25)
  const chown = os === 'Linux'
    ? ` && chown ${CONTAINER_UID}:${CONTAINER_UID} ${configPath}`
    : ''
  const cmd =
    `echo '${b64}' | base64 -d > ${OPENCLAW_TMP} && ` +
    `mv ${OPENCLAW_TMP} ${configPath}` +
    chown
  // On macOS the SSH user owns the config; on Linux the SSH user may differ
  // from "clawops" (e.g. AWS "ubuntu"), so fall back to sudo -n.
  const result = os === 'Darwin'
    ? await session.exec(cmd, signal)
    : await execPrivileged(session, cmd, signal)
  if (result.code !== 0) {
    throw new Error(`Failed to write config: ${result.stderr}`)
  }
}

/** Restart the OpenClaw container, preserving the current image tag. */
export async function restartGateway(
  session: SshSession,
  signal?: AbortSignal,
): Promise<void> {
  const os = await detectOS(session, signal)

  // Non-interactive SSH sessions get a minimal PATH on macOS (Docker Desktop /
  // Homebrew install outside /usr/bin). Linux always has /usr/bin/docker in PATH.
  const pathPrefix = os === 'Darwin'
    ? 'export PATH="/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:$PATH" && '
    : ''

  const imgCmd = `${pathPrefix}${IMAGE_INSPECT_CMD}`
  const imgResult = os === 'Darwin'
    ? await session.exec(imgCmd, signal)
    : await execPrivileged(session, imgCmd, signal)
  const resolved = imageForRestart(imgResult.stdout)
  if (!resolved.ok) throw new Error(resolved.error)
  const image = resolved.value

  // The token comes from the env file the bootstrap writes, not from config and not
  // from argv. Reading it out of openclaw.json stopped working when v1.7.2 moved the
  // token to an env file, and passing it on the command line exposed it in `ps`.
  // A restart preserves reachability as well as version — see publishForRestart.
  const pubCmd = `${pathPrefix}${PUBLISH_INSPECT_CMD}`
  const pubResult = os === 'Darwin'
    ? await session.exec(pubCmd, signal)
    : await execPrivileged(session, pubCmd, signal)

  const restartCmd = gatewayRunCommand({
    image,
    stateDir: stateDirForOS(os),
    pathPrefix,
    publish: publishForRestart(pubResult.stdout),
  })

  const result = os === 'Darwin'
    ? await session.exec(restartCmd, signal)
    : await execPrivileged(session, restartCmd, signal)
  if (result.code !== 0) {
    throw new Error(`Gateway restart failed: ${result.stderr}`)
  }

  // Health-gate the result. v1.7.2 starts delivering config that has never been
  // applied before, so a stored value can take effect for the first time here. The
  // port cases are already handled (normalise + argv pin); this catches whatever
  // they did not, by verifying the gateway actually answers before we call it done.
  const healthy = await waitForGateway(session, pathPrefix, signal)
  if (!healthy.ok) {
    throw new Error(
      `Gateway restarted but did not finish starting on port ${GATEWAY_PORT}` +
        (healthy.reason ? ` — ${healthy.reason}` : '') + `. ` +
        `The previous container has already been replaced; inspect it with ` +
        `\`docker logs openclaw\`. If the newly-applied config is at fault, ` +
        `revert it and restart — before v1.7.2 this config was never applied, so a ` +
        `value that has sat unused may now be taking effect.`,
    )
  }
}

/**
 * Poll until the gateway reports it has STARTED, or the budget runs out.
 *
 * `/startupz`, not `/health`: after a restart the process is listening long before startup
 * has finished, so a liveness probe returns ok while the gateway is still converging. The
 * caller is about to tell the operator the deploy succeeded.
 *
 * The body is judged, not the status code — see src/openclaw/health.ts for why a status
 * code cannot distinguish a healthy gateway from a typo'd path.
 */
async function waitForGateway(
  session: SshSession,
  pathPrefix: string,
  signal?: AbortSignal,
  attempts = 15,
): Promise<{ ok: boolean; reason?: string }> {
  const { probeCommand, interpretProbe } = await import('../openclaw/health.js')
  const probe = probeCommand('started', GATEWAY_PORT, pathPrefix)
  let last = 'no response from the gateway'
  for (let i = 0; i < attempts; i++) {
    if (signal?.aborted) return { ok: false, reason: 'aborted' }
    const r = await session.exec(probe, signal)
    const verdict = interpretProbe('started', r.stdout)
    if (verdict.ok) return { ok: true }
    last = verdict.reason ?? last
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  return { ok: false, reason: last }
}

/** Deep-merge overlay into base. Arrays in overlay replace (not concat) base arrays. */
export function deepMerge(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base }
  for (const [key, val] of Object.entries(overlay)) {
    if (
      val !== null &&
      typeof val === 'object' &&
      !Array.isArray(val) &&
      typeof result[key] === 'object' &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        val as Record<string, unknown>,
      )
    } else {
      result[key] = val
    }
  }
  return result
}
