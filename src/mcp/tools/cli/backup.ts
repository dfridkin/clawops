// STUB — replaced by its implementation.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { BackupCreateInput, BackupRestoreInput } from '../_generated.js'
import { errText } from '../_conn.js'

export async function handleBackupCreate(_input: BackupCreateInput, _server: McpServer): Promise<CallToolResult> {
  return errText('not implemented')
}

export async function handleBackupRestore(_input: BackupRestoreInput, _server: McpServer): Promise<CallToolResult> {
  return errText('not implemented')
}
