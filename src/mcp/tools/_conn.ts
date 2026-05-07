// Shared SSH connection helper for MCP tool handlers.
// Resolves connection info from context (local state or Pulumi outputs).

import type { ClawopsContext } from '../../cli/context.js'
import { StateError } from '../../errors/index.js'

export interface ConnInfo {
  host: string
  port: number
  user: string
  privateKeyPath: string
  knownHostsPath: string
}

export async function resolveConn(ctx: ClawopsContext): Promise<ConnInfo> {
  if (ctx.adapter.name === 'local') {
    const state = ctx.localState
    if (!state) throw new StateError('Stack has no local state — run `clawops up` first.')
    return {
      host: state.sshHost,
      port: state.sshPort,
      user: state.sshUser,
      privateKeyPath: state.privateKeyPath,
      knownHostsPath: state.knownHostsPath,
    }
  }

  const { extractBaseOutputs } = await import('../../pulumi/outputs.js')
  const stack = await ctx.getStack()
  const outputMap = await stack.outputs()
  const outputs: Record<string, unknown> = Object.fromEntries(
    Object.entries(outputMap).map(([k, v]) => [k, v.value]),
  )
  if (!outputs['publicIp']) {
    throw new StateError('Stack has no outputs — run `clawops up` first.')
  }
  const base = extractBaseOutputs(outputs)
  return ctx.adapter.getConnectionInfo({
    ...base,
    privateKeyPath: ctx.config.ssh.keyPath,
    knownHostsPath: ctx.config.ssh.knownHostsPath,
  })
}

/** CallToolResult helper — error text with isError flag. */
export function errText(message: string): import('@modelcontextprotocol/sdk/dist/esm/types.js').CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

/** CallToolResult helper — plain text. */
export function okText(t: string): import('@modelcontextprotocol/sdk/dist/esm/types.js').CallToolResult {
  return { content: [{ type: 'text', text: t }] }
}
