// clawops_logs_tail handler

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/dist/esm/types.js'
import type { LogsTailInput } from '../_generated.js'
import { buildContext } from '../../../cli/context.js'
import { acquireSession, drainPool } from '../../../transport/pool.js'
import { resolveConn, okText, errText } from '../_conn.js'

const MAX_BYTES = 8 * 1024

export async function handleLogsTail(input: LogsTailInput, _server: McpServer): Promise<CallToolResult> {
  const ctx = buildContext({ stack: input.stackName })
  const conn = await resolveConn(ctx)
  const { session, release } = await acquireSession(conn)
  try {
    const tailLines = input.tailLines ?? 100
    const sinceFlag = input.sinceMin ? `--since "${input.sinceMin} min ago"` : ''
    const command = [
      'journalctl -u openclaw',
      `-n ${tailLines}`,
      sinceFlag,
      '2>/dev/null',
      '|| docker logs openclaw',
      `-n ${tailLines}`,
    ]
      .filter(Boolean)
      .join(' ')

    const result = await session.exec(command)
    if (result.code !== 0 && !result.stdout) {
      return errText(`Failed to fetch logs: ${result.stderr}`)
    }

    let output = result.stdout
    if (Buffer.byteLength(output) > MAX_BYTES) {
      output = output.slice(0, MAX_BYTES) + '\n\n[output truncated at 8KB]'
    }
    return okText(output || '(no log output)')
  } finally {
    release()
    drainPool()
  }
}

function okText(t: string): CallToolResult {
  return { content: [{ type: 'text', text: t }] }
}
