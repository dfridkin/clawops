// clawops_logs_tail handler

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { LogsTailInput } from '../_generated.js'
import { buildContext } from '../../../cli/context.js'
import { acquireSession, drainPool } from '../../../transport/pool.js'
import { resolveConn, okText, errText } from '../_conn.js'
import { execPrivileged } from '../../../transport/privileged.js'
import {
  GATEWAY_LOGS_PROBE, chooseLogSource, gatewayLogsCommand, containerLogsCommand,
} from '../../../openclaw/logs.js'

const MAX_BYTES = 8 * 1024

export async function handleLogsTail(input: LogsTailInput, _server: McpServer): Promise<CallToolResult> {
  const ctx = buildContext({ stack: input.stackName })
  const conn = await resolveConn(ctx)
  const { session, release } = await acquireSession(conn)
  try {
    const tailLines = input.tailLines ?? 100
    const since = input.sinceMin ? `${input.sinceMin}m` : undefined

    // Same choice the CLI makes, from the same module — these two hand-rolled the identical
    // journalctl-or-docker chain and would have drifted apart the moment one was fixed.
    const probe = since
      ? { stdout: '' }
      : await execPrivileged(session, GATEWAY_LOGS_PROBE)
    const choice = chooseLogSource({ since, gatewayReachable: probe.stdout.trim() === 'ok' })
    const opts = { tail: tailLines, follow: false, since, json: choice.source === 'gateway' }
    const command =
      choice.source === 'gateway' ? gatewayLogsCommand(opts) : containerLogsCommand(opts)

    const result = await execPrivileged(session, command)
    if (result.code !== 0 && !result.stdout) {
      return errText(`Failed to fetch logs: ${result.stderr}`)
    }

    // The source is part of the answer, not decoration: an agent reading an empty result
    // needs to know whether the gateway had nothing to say or was never asked.
    let output = `[source: ${choice.source} — ${choice.reason}]\n${result.stdout}`
    if (Buffer.byteLength(output) > MAX_BYTES) {
      output = output.slice(0, MAX_BYTES) + '\n\n[output truncated at 8KB]'
    }
    return okText(result.stdout ? output : `[source: ${choice.source}]\n(no log output)`)
  } finally {
    release()
    drainPool()
  }
}
