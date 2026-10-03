// STUB — replaced by its implementation.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { MigrateInput } from '../_generated.js'
import { errText } from '../_conn.js'

export async function handleMigrate(_input: MigrateInput, _server: McpServer): Promise<CallToolResult> {
  return errText('not implemented')
}
