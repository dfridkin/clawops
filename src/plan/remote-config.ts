// Shared SSH helpers for reading/writing openclaw.json on a remote host.
// Used by apply.ts (cloud post-provisioning) and up.ts (local --config).
// Extracted so the MCP config handler and plan layer share one implementation.

import type { SshSession, SshExecResult } from '../transport/ssh.js'

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
  const result = await session.exec(`cat ${configPath}`, signal)
  if (result.code !== 0) {
    throw new Error(`Cannot read ${configPath}: ${result.stderr}`)
  }
  try {
    return JSON.parse(result.stdout) as Record<string, unknown>
  } catch {
    throw new Error(`Cannot parse ${configPath}: invalid JSON`)
  }
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

  const imgCmd = `${pathPrefix}docker inspect openclaw --format '{{.Config.Image}}' 2>/dev/null || echo 'ghcr.io/openclaw/openclaw:latest'`
  const imgResult = os === 'Darwin'
    ? await session.exec(imgCmd, signal)
    : await execWithFallbackSudo(session, imgCmd, signal)
  const image = imgResult.stdout.trim()

  // Read the auth token from the config that was just written so we can pass it
  // explicitly to `gateway run --token`. This ensures the gateway enforces the
  // specific token rather than relying on --allow-unconfigured defaults.
  const cfgResult = await session.exec(`cat ${configPath}`, signal)
  // --allow-unconfigured is always passed: it lets the gateway start without
  // requiring a fully-validated model config in /app/config.json.
  // --token TOKEN overlays the auth token so the session requires the correct secret.
  let gatewayCmd = 'node openclaw.mjs gateway run --allow-unconfigured'
  try {
    const cfg = JSON.parse(cfgResult.stdout) as Record<string, unknown>
    const token = (cfg?.['gateway'] as Record<string, unknown>)?.['auth'] as Record<string, unknown>
    const tokenVal = token?.['token'] as string | undefined
    if (tokenVal) {
      gatewayCmd = `node openclaw.mjs gateway run --allow-unconfigured --token '${tokenVal}'`
    }
  } catch { /* keep allow-unconfigured-only fallback */ }

  const restartCmd =
    pathPrefix +
    [
      'docker stop openclaw 2>/dev/null || true',
      'docker rm openclaw 2>/dev/null || true',
      `docker run -d --name openclaw --restart unless-stopped -p 18789:18789 ` +
        `-v ${configPath}:/app/config.json:ro ${image} ${gatewayCmd}`,
    ].join(' && ')

  const result = os === 'Darwin'
    ? await session.exec(restartCmd, signal)
    : await execWithFallbackSudo(session, restartCmd, signal)
  if (result.code !== 0) {
    throw new Error(`Gateway restart failed: ${result.stderr}`)
  }
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
