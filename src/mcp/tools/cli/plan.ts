// clawops_plan handler — M6 stub

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { PlanInput } from '../_generated.js'

export async function handlePlan(_input: PlanInput, _server: McpServer): Promise<CallToolResult> {
  return {
    content: [{ type: 'text', text: 'clawops_plan: not yet implemented (M6)' }],
    isError: true,
  }
}
