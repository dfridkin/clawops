// clawops_plan handler

import { writeFileSync } from 'node:fs'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { PlanInput } from '../_generated.js'
import { errText } from '../_conn.js'
import { trimForMcp } from '../_trim.js'
import { buildContext } from '../../../cli/context.js'
import { generatePlan } from '../../../plan/generate.js'

export async function handlePlan(input: PlanInput, _server: McpServer): Promise<CallToolResult> {
  const ctx = buildContext({
    stack: input.stackName,
    provider: input.provider,
  })

  if (ctx.adapter.name === 'local') {
    return errText('plan/apply is not supported for the local provider. Use clawops_up directly.')
  }

  // adapter.name is 'local' guard is above; safe to narrow here
  const provider = (input.provider ?? ctx.adapter.name) as 'aws' | 'gcp' | 'azure'
  const stackName = ctx.stackName

  let plan: import('../../../plan/generate.js').DeployPlan
  try {
    plan = await generatePlan({
      stackName,
      provider,
      region: input.region,
      instanceType: input.instanceType,
    })
  } catch (err) {
    return errText(`Plan generation failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  const planJson = JSON.stringify(plan, null, 2)

  if (input.outPath) {
    try {
      writeFileSync(input.outPath, planJson + '\n', 'utf-8')
      return { content: [{ type: 'text', text: `Plan written to ${input.outPath}` }] }
    } catch (err) {
      return errText(`Failed to write plan to ${input.outPath}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const { content, truncated } = trimForMcp(planJson, stackName)
  return {
    content: [{ type: 'text', text: truncated ? content : planJson }],
  }
}
