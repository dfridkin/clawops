// Shared SSH helpers for reading/writing openclaw.json on a remote host.
// Used by apply.ts (cloud post-provisioning) and up.ts (local --config).
// Extracted so the MCP config handler and plan layer share one implementation.

import type { SshSession, SshExecResult } from '../transport/ssh.js'
import { GATEWAY_PORT, IMAGE_INSPECT_CMD, imageForRestart } from '../openclaw/run-flags.js'
import { gatewayRunCommand } from '../openclaw/runtime.js'

export const OPENCLAW_CONFIG_LINUX = '/home/clawops/openclaw.json'
export const OPENCLAW_CONFIG_MACOS = '~/.config/openclaw/config.json'
export const OPENCLAW_CONFIG = OPENCLAW_CONFIG_LINUX  // kept for back-compat
export const OPENCLAW_TMP = '/tmp/clawops-config.json.tmp'

async function detectOS(session: SshSession, signal?: AbortSignal): Promise<'Linux' | 'Darwin'> {
  const result = await session.exec('uname -s', signal)
  return result.stdout.trim() === 'Darwin' ? 'Darwin' : 'Linux'
}

function configPathForOS(os: 'Linux' | 'Darwin'): string {
  return os === 'Darwin' ? OPENCLAW_CONFIG_MACOS : OPENCLAW_CONFIG_LINUX
}

/**
 * Run cmd directly; if it fails, retry under `sudo -n` (non-interactive).
 * This handles cloud VMs where the SSH user (e.g. AWS "ubuntu") is not the
 * "clawops" service user but has passwordless sudo configured.
 * On GCP/Azure where SSH connects as "clawops", the direct attempt succeeds.
 */
async function execWithFallbackSudo(
  session: SshSession,
  cmd: string,
  signal?: AbortSignal,
): Promise<SshExecResult> {
  const result = await session.exec(cmd, signal)
  if (result.code === 0) return result
  // Wrap in double-quotes: base64 alphabet and our path strings contain no
  // double-quote or $ characters, and inner single-quotes are literal inside "".
  return session.exec(`sudo -n bash -c "${cmd}"`, signal)
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
    : await execWithFallbackSudo(session, `cat ${configPath}`, signal)
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
export async function atomicWriteConfig(
  session: SshSession,
  cfg: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<void> {
  const os = await detectOS(session, signal)
  const configPath = configPathForOS(os)
  const json = JSON.stringify(cfg, null, 2)
  const b64 = Buffer.from(json, 'utf-8').toString('base64')
  const chown = os === 'Linux' ? ` && chown clawops:clawops ${configPath}` : ''
  const cmd =
    `echo '${b64}' | base64 -d > ${OPENCLAW_TMP} && ` +
    `mv ${OPENCLAW_TMP} ${configPath}` +
    chown
  // On macOS the SSH user owns the config; on Linux the SSH user may differ
  // from "clawops" (e.g. AWS "ubuntu"), so fall back to sudo -n.
  const result = os === 'Darwin'
    ? await session.exec(cmd, signal)
    : await execWithFallbackSudo(session, cmd, signal)
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
  const configPath = configPathForOS(os)

  // Non-interactive SSH sessions get a minimal PATH on macOS (Docker Desktop /
  // Homebrew install outside /usr/bin). Linux always has /usr/bin/docker in PATH.
  const pathPrefix = os === 'Darwin'
    ? 'export PATH="/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:$PATH" && '
    : ''

  const imgCmd = `${pathPrefix}${IMAGE_INSPECT_CMD}`
  const imgResult = os === 'Darwin'
    ? await session.exec(imgCmd, signal)
    : await execWithFallbackSudo(session, imgCmd, signal)
  const resolved = imageForRestart(imgResult.stdout)
  if (!resolved.ok) throw new Error(resolved.error)
  const image = resolved.value

  // The token comes from the env file the bootstrap writes, not from config and not
  // from argv. Reading it out of openclaw.json stopped working when v1.7.2 moved the
  // token to an env file, and passing it on the command line exposed it in `ps`.
  const restartCmd = gatewayRunCommand({
    image,
    configPath,
    pathPrefix,
  })

  const result = os === 'Darwin'
    ? await session.exec(restartCmd, signal)
    : await execWithFallbackSudo(session, restartCmd, signal)
  if (result.code !== 0) {
    throw new Error(`Gateway restart failed: ${result.stderr}`)
  }

  // Health-gate the result. v1.7.2 starts delivering config that has never been
  // applied before, so a stored value can take effect for the first time here. The
  // port cases are already handled (normalise + argv pin); this catches whatever
  // they did not, by verifying the gateway actually answers before we call it done.
  const healthy = await waitForGateway(session, pathPrefix, signal)
  if (!healthy) {
    throw new Error(
      `Gateway restarted but did not become healthy on port ${GATEWAY_PORT}. ` +
        `The previous container has already been replaced; inspect it with ` +
        `\`docker logs openclaw\`. If the newly-applied config is at fault, ` +
        `revert it and restart — before v1.7.2 this config was never applied, so a ` +
        `value that has sat unused may now be taking effect.`,
    )
  }
}

/** Poll the gateway's health endpoint until it answers or the budget runs out. */
async function waitForGateway(
  session: SshSession,
  pathPrefix: string,
  signal?: AbortSignal,
  attempts = 15,
): Promise<boolean> {
  const probe =
    `${pathPrefix}curl -fsS -m 3 http://127.0.0.1:${GATEWAY_PORT}/healthz >/dev/null 2>&1 ` +
    `&& echo ok || echo waiting`
  for (let i = 0; i < attempts; i++) {
    if (signal?.aborted) return false
    const r = await session.exec(probe, signal)
    if (r.stdout.trim().endsWith('ok')) return true
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  return false
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
