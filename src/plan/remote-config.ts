// Shared SSH helpers for reading/writing openclaw.json on a remote host.
// Used by apply.ts (cloud post-provisioning) and up.ts (local --config).
// Extracted so the MCP config handler and plan layer share one implementation.

import type { SshSession } from '../transport/ssh.js'

export const OPENCLAW_CONFIG = '/home/clawops/openclaw.json'
export const OPENCLAW_CONFIG_MACOS = '~/openclaw.json'
export const OPENCLAW_TMP = '/tmp/clawops-config.json.tmp'

/** Read and parse openclaw.json from the remote host. */
export async function readRemoteConfig(
  session: SshSession,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const result = await session.exec(`cat ${OPENCLAW_CONFIG}`, signal)
  if (result.code !== 0) {
    throw new Error(`Cannot read ${OPENCLAW_CONFIG}: ${result.stderr}`)
  }
  try {
    return JSON.parse(result.stdout) as Record<string, unknown>
  } catch {
    throw new Error(`Cannot parse ${OPENCLAW_CONFIG}: invalid JSON`)
  }
}

/** Atomically write a config object to the remote openclaw.json. */
export async function atomicWriteConfig(
  session: SshSession,
  cfg: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<void> {
  const json = JSON.stringify(cfg, null, 2)
  const b64 = Buffer.from(json, 'utf-8').toString('base64')
  const cmd =
    `echo '${b64}' | base64 -d > ${OPENCLAW_TMP} && ` +
    `mv ${OPENCLAW_TMP} ${OPENCLAW_CONFIG} && ` +
    `chown clawops:clawops ${OPENCLAW_CONFIG}`
  const result = await session.exec(cmd, signal)
  if (result.code !== 0) {
    throw new Error(`Failed to write config: ${result.stderr}`)
  }
}

/** Restart the OpenClaw container, preserving the current image tag. */
export async function restartGateway(
  session: SshSession,
  signal?: AbortSignal,
): Promise<void> {
  const imgResult = await session.exec(
    `docker inspect openclaw --format '{{.Config.Image}}' 2>/dev/null || echo 'ghcr.io/openclaw/openclaw:stable'`,
    signal,
  )
  const image = imgResult.stdout.trim()
  const cmd = [
    'docker stop openclaw 2>/dev/null || true',
    'docker rm openclaw 2>/dev/null || true',
    `docker run -d --name openclaw --restart unless-stopped -p 18789:18789 ` +
      `-v ${OPENCLAW_CONFIG}:/app/config.json:ro ${image}`,
  ].join(' && ')
  const result = await session.exec(cmd, signal)
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
