// clawops_agents_list + clawops_agents_restart handlers

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { AgentsListInput, AgentsRestartInput } from '../_generated.js'
import { buildContext } from '../../../cli/context.js'
import { acquireSession, drainPool } from '../../../transport/pool.js'
import { resolveConn, okText, errText } from '../_conn.js'

export async function handleAgentsList(input: AgentsListInput, _server: McpServer): Promise<CallToolResult> {
  const ctx = buildContext({ stack: input.stackName })
  const conn = await resolveConn(ctx)
  const { session, release } = await acquireSession(conn)
  try {
    const result = await session.exec('docker exec openclaw openclaw-ctl agents list --json 2>&1 || echo "[]"')
    return okText(result.stdout.trim())
  } finally {
    release()
    drainPool()
  }
}

export async function handleAgentsRestart(input: AgentsRestartInput, server: McpServer): Promise<CallToolResult> {
  // R19: always elicit
  const elicit = await server.server.elicitInput({
    message: `Restart agent "${input.agentId}" on stack "${input.stackName ?? 'default'}"?`,
    requestedSchema: {
      type: 'object' as const,
      properties: { confirmed: { type: 'boolean' as const, title: 'Confirm restart' } },
      required: ['confirmed'],
    },
  })
  if (elicit.action !== 'accept' || !elicit.content?.['confirmed']) {
    return okText('Agent restart cancelled.')
  }

  const ctx = buildContext({ stack: input.stackName })
  const conn = await resolveConn(ctx)
  const { session, release } = await acquireSession(conn)
  try {
    const result = await session.exec(
      `docker exec openclaw openclaw-ctl agents restart ${input.agentId} 2>&1`,
    )
    if (result.code !== 0) {
      return errText(`Failed to restart agent: ${result.stderr || result.stdout}`)
    }
    return okText(`Agent "${input.agentId}" restarted.`)
  } finally {
    release()
    drainPool()
  }
}
