// clawops_stacks_list handler

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { StacksListInput } from '../_generated.js'
import { getConfig } from '../../../config/store.js'

export async function handleStacksList(_input: StacksListInput, _server: McpServer): Promise<CallToolResult> {
  const config = getConfig()
  if (!config) {
    return { content: [{ type: 'text', text: JSON.stringify({ stacks: [] }) }] }
  }
  const stacks = Object.entries(config.stacks).map(([name, cfg]) => ({
    name,
    provider: cfg.provider,
    region: cfg.region,
    stateUrl: cfg.stateUrl,
    isDefault: name === config.defaults.stack,
  }))
  return { content: [{ type: 'text', text: JSON.stringify({ stacks }, null, 2) }] }
}

// STUB — replaced by its implementation.
export async function handleStacksDelete(_input: import('../_generated.js').StacksDeleteInput, _server: McpServer): Promise<CallToolResult> {
  return { content: [{ type: 'text', text: 'not implemented' }], isError: true }
}
