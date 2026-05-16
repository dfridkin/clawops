// clawops_monitor handler — live stack health snapshot

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { MonitorInput } from '../_generated.js'
import { buildContext } from '../../../cli/context.js'
import { extractBaseOutputs } from '../../../pulumi/outputs.js'
import { gatherSnapshot, formatUptime } from '../../../cli/commands/monitor.js'

export async function handleMonitor(input: MonitorInput, _server: McpServer): Promise<CallToolResult> {
  const { acquireSession, drainPool } = await import('../../../transport/pool.js')

  const ctx = buildContext({ stack: input.stackName })
  const tailLines = input.tailLines ?? 5

  let conn: { host: string; port: number; user: string; privateKeyPath: string; knownHostsPath: string }

  if (ctx.adapter.name === 'local') {
    if (!ctx.localState) {
      return text(JSON.stringify({ error: 'Stack is not bootstrapped. Run `clawops up` first.' }))
    }
    const ls = ctx.localState
    conn = { host: ls.sshHost, port: ls.sshPort, user: ls.sshUser, privateKeyPath: ls.privateKeyPath, knownHostsPath: ls.knownHostsPath }
  } else {
    const stack = await ctx.getStack()
    const outputMap = await stack.outputs()
    const outputs: Record<string, unknown> = Object.fromEntries(
      Object.entries(outputMap).map(([k, v]) => [k, v.value]),
    )
    if (!outputs['publicIp']) {
      return text(JSON.stringify({ error: 'Stack has no outputs. Run `clawops up` first.' }))
    }
    const base = extractBaseOutputs(outputs)
    conn = ctx.adapter.getConnectionInfo({
      ...base,
      privateKeyPath: ctx.config.ssh.keyPath,
      knownHostsPath: ctx.config.ssh.knownHostsPath,
    })
  }

  const ac = new AbortController()
  const { session, release } = await acquireSession({ ...conn, signal: ac.signal })

  try {
    const snap = await gatherSnapshot(session, ac.signal, tailLines)

    return text(JSON.stringify({
      gateway: snap.gateway,
      container: {
        status: snap.container.status,
        image: snap.container.image,
        restartCount: snap.container.restartCount,
        memUsage: snap.container.memUsage,
        cpuPct: snap.container.cpuPct,
        uptime: formatUptime(snap.container.startedAt),
      },
      disk: snap.disk,
      logLines: snap.logLines,
      capturedAt: snap.capturedAt.toISOString(),
    }, null, 2))
  } finally {
    release()
    drainPool()
    ac.abort()
  }
}

function text(t: string): CallToolResult {
  return { content: [{ type: 'text', text: t }] }
}
