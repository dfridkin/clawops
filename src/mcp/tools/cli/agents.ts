// clawops_agents_list handler
//
// clawops_agents_restart was removed in clawops 2.0: OpenClaw 2.0 has no per-agent
// restart, and the gateway-wide one is already clawops_gateway_restart. An agent
// calling a tool named "agents_restart" would reasonably expect agent scope.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { AgentsListInput } from '../_generated.js'
import { buildContext } from '../../../cli/context.js'
import { acquireSession, drainPool } from '../../../transport/pool.js'
import { resolveConn, okText } from '../_conn.js'

export async function handleAgentsList(input: AgentsListInput, _server: McpServer): Promise<CallToolResult> {
  const ctx = buildContext({ stack: input.stackName })
  const conn = await resolveConn(ctx)
  const { session, release } = await acquireSession(conn)
  try {
    const result = await session.exec('docker exec openclaw openclaw agents list --json 2>&1 || echo "[]"')
    return okText(result.stdout.trim())
  } finally {
    release()
    drainPool()
  }
}
