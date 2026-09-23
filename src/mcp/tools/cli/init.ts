// clawops_init handler
//
// The call that makes every other call possible. Without a config, each tool refuses and names
// this one; on a machine that has never run clawops — a directory's sandbox, a fresh container —
// that refusal was the entire experience of the server.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { InitInput } from '../_generated.js'
import { okText, errText } from '../_conn.js'

export async function handleInit(input: InitInput, _server: McpServer): Promise<CallToolResult> {
  const { initStack } = await import('../../../config/init.js')

  const result = await initStack({
    provider: input.provider,
    stackName: input.stackName,
    stateUrl: input.stateUrl,
    region: input.region,
    force: input.force,
    host: input.host,
    sshUser: input.sshUser,
    sshPort: input.sshPort,
  })

  if (!result.ok) return errText(result.reason)

  const lines = [
    `Stack "${result.stackName}" registered for ${result.provider}.`,
    `Config:        ${result.configPath}`,
    `State backend: ${result.stateUrl}`,
    ...(result.region ? [`Region:        ${result.region}`] : []),
    `SSH key:       ${result.keyPath}${result.keyGenerated ? ' (generated now)' : ' (already existed)'}`,
    '',
    'Nothing has been provisioned and nothing is being charged. Deploying from here needs cloud ' +
      'credentials in the environment clawops runs in; clawops_doctor reports which are missing.',
  ]
  return okText(lines.join('\n'))
}
