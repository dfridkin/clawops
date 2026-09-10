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
import { resolveConn, okText, errText } from '../_conn.js'
import { execPrivileged } from '../../../transport/privileged.js'

export async function handleAgentsList(input: AgentsListInput, _server: McpServer): Promise<CallToolResult> {
  const ctx = buildContext({ stack: input.stackName })
  const conn = await resolveConn(ctx)
  const { session, release } = await acquireSession(conn)
  try {
    // No `|| echo "[]"`. That turned every failure into an empty list, and an agent
    // cannot tell "this deployment has no agents" from "I could not ask" — the second
    // reads as the first and gets acted on. Same reason stderr is not folded into stdout:
    // an error message is not a JSON array, and returning it as one invites a parse of
    // whatever the container happened to print.
    const result = await execPrivileged(session, 'docker exec openclaw openclaw agents list --json')
    if (result.code !== 0) {
      return errText(`Cannot list agents: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`)
    }
    return okText(result.stdout.trim() || '[]')
  } finally {
    release()
    drainPool()
  }
}
