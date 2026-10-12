// clawops_workflow_recover handler
// Composite: status → health checks → logs → a diagnostic report with next steps.
//
// It used to describe "status → gateway logs → agent logs → systemd service status" and run the
// first two, and its next steps sent agents to `clawops refresh`, a command that does not exist.
// The health checks are the ones `clawops_doctor` runs for a stack, which is where clawops
// actually answers "is the gateway up, on what version, and does it start".

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { WorkflowRecoverInput } from '../_generated.js'
import { handleStatus } from '../cli/status.js'
import { handleDoctor } from '../cli/doctor.js'
import { handleLogsTail } from '../cli/logs.js'
import { trimForMcp } from '../_trim.js'

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c) => c.type === 'text')
    .map((c) => (c as { type: 'text'; text: string }).text)
    .join('')
}

async function section(title: string, fence: string, run: () => Promise<CallToolResult>): Promise<string> {
  try {
    const result = await run()
    return result.isError
      ? `### ${title}\nError: ${textOf(result)}`
      : `### ${title}\n\`\`\`${fence}\n${textOf(result)}\n\`\`\``
  } catch (err) {
    return `### ${title}\nError: ${err instanceof Error ? err.message : String(err)}`
  }
}

export async function handleWorkflowRecover(
  input: WorkflowRecoverInput,
  server: McpServer,
): Promise<CallToolResult> {
  const stack = input.stackName ?? 'default'
  const parts: string[] = [`## Diagnostic Report — stack: ${stack}\n`]

  parts.push(await section('Status', 'json', () => handleStatus({ stackName: input.stackName }, server)))
  parts.push(await section('Failed health checks', 'json', () =>
    handleDoctor({ stackName: input.stackName, failuresOnly: true }, server)))
  parts.push(await section('Recent Logs (last 50 lines)', '', () =>
    handleLogsTail({ stackName: input.stackName, tailLines: 50 }, server)))

  parts.push(
    `### Next Steps\n` +
      `- Gateway not running, or not answering: \`clawops_gateway_restart\`\n` +
      `- Gateway fails on its current version: \`clawops_gateway_update\` to a version that worked, ` +
      `or \`clawops_backup_restore\` with \`activate\` if the state is at fault\n` +
      `- Host not set up, or set up only partly: \`clawops_up\` again (it is idempotent)\n` +
      `- Infrastructure differs from what was deployed: \`clawops_plan\`, review, then \`clawops_apply\`\n` +
      `- Nothing deployed yet: \`clawops_workflow_deploy_app\``,
  )

  // R14: three tool outputs together can pass the cap even when each alone does not.
  const { content } = trimForMcp(parts.join('\n\n'), stack)
  return { content: [{ type: 'text', text: content }] }
}
