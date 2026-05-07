// clawops_workflow_deploy_app handler
// Composite: plan → elicit (with diff) → apply → status

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { WorkflowDeployAppInput } from '../_generated.js'
import { handleUp } from '../cli/up.js'
import { handleStatus } from '../cli/status.js'
import { okText } from '../_conn.js'
import { makeProgressEmitter } from '../../progress.js'
import { generatePlan } from '../../../plan/generate.js'
import { applyPlan } from '../../../plan/apply.js'

export async function handleWorkflowDeployApp(
  input: WorkflowDeployAppInput,
  server: McpServer,
): Promise<CallToolResult> {
  const parts: string[] = [`## Deployment Workflow — ${input.provider} / ${input.stackName}\n`]

  // Local provider: no plan/apply support — fall back to handleUp directly
  if (input.provider === 'local') {
    return handleUp(
      { stackName: input.stackName, provider: input.provider, region: input.region, instanceType: input.instanceType, dryRun: false },
      server,
    )
  }

  const provider = input.provider as 'aws' | 'gcp' | 'azure'

  // Step 1: generate plan (runs preview to populate diff)
  parts.push('### Step 1: Plan')
  let plan: Awaited<ReturnType<typeof generatePlan>>
  try {
    plan = await generatePlan({
      stackName: input.stackName,
      provider,
      region: input.region,
      instanceType: input.instanceType,
    })
    const diffSummary = plan.diff
      ? `${plan.diff.create.length} to create, ${plan.diff.update.length} to update, ${plan.diff.delete.length} to delete`
      : 'diff unavailable'
    parts.push(`Plan generated. Changes: ${diffSummary}.`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    parts.push(`Plan generation failed: ${msg}\nFalling back to direct deployment.`)
    // Fall back to handleUp (which has its own elicitation)
    return handleUp(
      { stackName: input.stackName, provider: input.provider, region: input.region, instanceType: input.instanceType, dryRun: false },
      server,
    )
  }

  // Step 2: R19 elicitation with diff context
  const diffLine = plan.diff
    ? `${plan.diff.create.length} to create, ${plan.diff.update.length} to update, ${plan.diff.delete.length} to delete`
    : '? changes'
  const elicit = await server.server.elicitInput({
    message:
      `Deploy OpenClaw on ${provider} (stack: "${input.stackName}", instance: ${input.instanceType}` +
      `${input.region ? `, region: ${input.region}` : ''})?\n` +
      `Changes: ${diffLine}. This will provision cloud resources and may incur costs.`,
    requestedSchema: {
      type: 'object' as const,
      properties: { confirmed: { type: 'boolean' as const, title: 'Confirm end-to-end deployment' } },
      required: ['confirmed'],
    },
  })
  if (elicit.action !== 'accept' || !elicit.content?.['confirmed']) {
    return okText('Deployment workflow cancelled.')
  }

  // Step 3: apply plan
  parts.push('### Step 2: Apply')
  const emit = makeProgressEmitter(server, undefined)
  try {
    const result = await applyPlan(plan, { onOutput: (line) => emit(line.trim()) })
    const changed = Object.entries(result.changeSummary).filter(([, n]) => n > 0)
    const applySummary = changed.length > 0
      ? changed.map(([op, n]) => `  ${op}: ${n}`).join('\n')
      : 'No changes.'
    parts.push(applySummary)
    if (result.outputs['gatewayUrl']) parts.push(`Gateway URL: ${result.outputs['gatewayUrl']}`)
    if (result.outputs['publicIp'])  parts.push(`Public IP:   ${result.outputs['publicIp']}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    parts.push(`Apply failed: ${msg}`)
    return { content: [{ type: 'text', text: parts.join('\n\n') }], isError: true }
  }

  // Step 4: post-deploy status
  parts.push('### Step 3: Status')
  try {
    const statusResult = await handleStatus({ stackName: input.stackName }, server)
    const statusText = statusResult.content
      .filter((c) => c.type === 'text')
      .map((c) => (c as { type: 'text'; text: string }).text)
      .join('')
    parts.push(statusText)
  } catch {
    parts.push('Status check skipped (stack may still be starting up).')
  }

  return { content: [{ type: 'text', text: parts.join('\n\n') }] }
}
