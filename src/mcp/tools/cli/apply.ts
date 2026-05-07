// clawops_apply handler

import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ApplyInput } from '../_generated.js'
import { okText, errText } from '../_conn.js'
import { trimForMcp } from '../_trim.js'
import { makeProgressEmitter, startTask, updateTask } from '../../progress.js'
import { validatePlan } from '../../../plan/validate.js'
import { applyPlan } from '../../../plan/apply.js'
import type { DeployPlan } from '../../../plan/generate.js'

export async function handleApply(input: ApplyInput, server: McpServer): Promise<CallToolResult> {
  // Read and parse plan file
  let plan: DeployPlan
  try {
    const raw = readFileSync(input.planPath, 'utf-8')
    plan = JSON.parse(raw) as DeployPlan
  } catch (err) {
    return errText(`Cannot read plan file "${input.planPath}": ${err instanceof Error ? err.message : String(err)}`)
  }

  const validation = validatePlan(plan)
  if (!validation.ok) {
    return errText(`Invalid plan:\n${validation.errors.join('\n')}`)
  }

  if (plan.spec.provider === 'local') {
    return errText('plan/apply is not supported for the local provider. Use clawops_up directly.')
  }

  // R19: elicit unless yes flag
  if (!input.yes) {
    const diffLine = plan.diff
      ? `${plan.diff.create.length} to create, ${plan.diff.update.length} to update, ${plan.diff.delete.length} to delete`
      : 'diff unavailable'
    const elicit = await server.server.elicitInput({
      message:
        `Apply plan for stack "${plan.spec.stackName}" (${plan.spec.provider})?\n` +
        `Changes: ${diffLine}.\nThis will provision cloud resources and may incur costs.`,
      requestedSchema: {
        type: 'object' as const,
        properties: { confirmed: { type: 'boolean' as const, title: 'Confirm plan apply' } },
        required: ['confirmed'],
      },
    })
    if (elicit.action !== 'accept' || !elicit.content?.['confirmed']) {
      return okText('Apply cancelled.')
    }
  }

  const taskId = randomUUID()
  const emit = makeProgressEmitter(server, undefined)
  startTask(taskId, `clawops_apply stack=${plan.spec.stackName}`)

  try {
    const result = await applyPlan(plan, {
      onOutput: (line) => emit(line.trim()),
    })

    const summaryLines = [`Stack "${plan.spec.stackName}" applied.`]
    const changed = Object.entries(result.changeSummary).filter(([, n]) => n > 0)
    if (changed.length > 0) {
      summaryLines.push(changed.map(([op, n]) => `  ${op}: ${n}`).join('\n'))
    }
    if (result.outputs['gatewayUrl']) summaryLines.push(`Gateway URL: ${result.outputs['gatewayUrl']}`)
    if (result.outputs['publicIp'])  summaryLines.push(`Public IP:   ${result.outputs['publicIp']}`)
    summaryLines.push(`Duration: ${(result.durationMs / 1000).toFixed(1)}s`)

    const summary = summaryLines.join('\n')
    updateTask(taskId, 'completed', summary)
    const { content } = trimForMcp(summary, plan.spec.stackName)
    return okText(content)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    updateTask(taskId, 'failed', undefined, msg)
    throw err
  }
}
