// Shared logic for wiring the gateway AI to clawops as an MCP client (WO-28).
// Used by `clawops mcp wire` and the setup wizard.

import type { SshSession } from '../transport/ssh.js'
import {
  readRemoteConfig,
  atomicWriteConfig,
  deepMerge,
  restartGateway,
} from '../plan/remote-config.js'

export const GATEWAY_MCP_MIN_VERSION = '2026.4'

export const GATEWAY_MCP_ENTRY = {
  command: 'clawops',
  args: ['mcp', 'serve'],
  transport: 'stdio',
} as const

export type WireResult =
  | { status: 'wired'; rewired: boolean }
  | { status: 'version-blocked'; version: string }

function versionAtLeast(version: string, min: string): boolean {
  const [vy = 0, vm = 0] = version.split('.').map(Number)
  const [my = 0, mm = 0] = min.split('.').map(Number)
  if (vy !== my) return vy > my
  return vm >= mm
}

export async function wireGatewayMcp(
  session: SshSession,
  signal: AbortSignal,
  opts: { force?: boolean } = {},
): Promise<WireResult> {
  const cfg = await readRemoteConfig(session, signal)

  const version = (cfg['meta'] as Record<string, unknown> | undefined)?.['lastTouchedVersion'] as string | undefined

  if (version && !versionAtLeast(version, GATEWAY_MCP_MIN_VERSION) && !opts.force) {
    return { status: 'version-blocked', version }
  }

  const mcpClients = ((cfg['gateway'] as Record<string, unknown> | undefined)?.['mcpClients']) as Record<string, unknown> | undefined
  const rewired = !!mcpClients?.['clawops']

  const updated = deepMerge(cfg, {
    gateway: {
      mcpClients: {
        clawops: GATEWAY_MCP_ENTRY,
      },
    },
  })

  await atomicWriteConfig(session, updated, signal)
  await restartGateway(session, signal)

  return { status: 'wired', rewired }
}
