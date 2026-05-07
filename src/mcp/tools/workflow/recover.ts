// clawops_workflow_recover handler
// Composite: status → logs → return diagnostic summary

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/dist/esm/types.js'
import type { WorkflowRecoverInput } from '../_generated.js'
import { handleStatus } from '../cli/status.js'
import { handleLogsTail } from '../cli/logs.js'

export async function handleWorkflowRecover(
  input: WorkflowRecoverInput,
  server: McpServer,
): Promise<CallToolResult> {
  const parts: string[] = [`## Diagnostic Report — stack: ${input.stackName ?? 'default'}\n`]

  // 1. Status
  try {
    const statusResult = await handleStatus({ stackName: input.stackName }, server)
    const statusText = statusResult.content
      .filter((c) => c.type === 'text')
      .map((c) => (c as { type: 'text'; text: string }).text)
      .join('')
    parts.push(`### Status\n\`\`\`json\n${statusText}\n\`\`\``)
  } catch (err) {
    parts.push(`### Status\nError: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 2. Recent logs (last 50 lines)
  try {
    const logsResult = await handleLogsTail({ stackName: input.stackName, tailLines: 50 }, server)
    const logsText = logsResult.content
      .filter((c) => c.type === 'text')
      .map((c) => (c as { type: 'text'; text: string }).text)
      .join('')
    parts.push(`### Recent Logs (last 50 lines)\n\`\`\`\n${logsText}\n\`\`\``)
  } catch (err) {
    parts.push(`### Recent Logs\nError: ${err instanceof Error ? err.message : String(err)}`)
  }

  parts.push(
    `### Next Steps\n` +
      `- If gateway is not running: try \`clawops_gateway_restart\`\n` +
      `- If bootstrap failed: run \`clawops_up\` again (idempotent)\n` +
      `- If stack is not deployed: run \`clawops_workflow_deploy_app\`\n` +
      `- For Pulumi drift: run \`clawops refresh\` from the CLI`,
  )

  return { content: [{ type: 'text', text: parts.join('\n\n') }] }
}
