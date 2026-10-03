// STUB — replaced by its implementation.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { SecretListInput, SecretAuditInput, SecretDeleteInput } from '../_generated.js'
import { errText } from '../_conn.js'

export async function handleSecretList(_input: SecretListInput, _server: McpServer): Promise<CallToolResult> {
  return errText('not implemented')
}

export async function handleSecretAudit(_input: SecretAuditInput, _server: McpServer): Promise<CallToolResult> {
  return errText('not implemented')
}

export async function handleSecretDelete(_input: SecretDeleteInput, _server: McpServer): Promise<CallToolResult> {
  return errText('not implemented')
}
