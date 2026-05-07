// clawops_apply handler — M6 stub (elicitation shape present for M6 compatibility)

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ApplyInput } from '../_generated.js'

export async function handleApply(_input: ApplyInput, _server: McpServer): Promise<CallToolResult> {
  return {
    content: [{ type: 'text', text: 'clawops_apply: not yet implemented (M6)' }],
    isError: true,
  }
}
