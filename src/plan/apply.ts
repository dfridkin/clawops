// Maker plan apply — per SPEC.md §12.6.

import { buildContext } from '../cli/context.js'
import { UsageError } from '../errors/index.js'
import { validatePlan } from './validate.js'
import type { DeployPlan } from './generate.js'

export interface ApplyPlanOpts {
  onOutput?: (line: string) => void
  signal?: AbortSignal
}

export interface ApplyPlanResult {
  outputs: Record<string, unknown>
  changeSummary: Record<string, number>
  durationMs: number
}

export async function applyPlan(
  plan: DeployPlan,
  opts?: ApplyPlanOpts,
): Promise<ApplyPlanResult> {
  const validation = validatePlan(plan)
  if (!validation.ok) {
    throw new UsageError(
      `Invalid deploy plan:\n${validation.errors.join('\n')}`,
    )
  }

  if (plan.spec.provider === 'local') {
    throw new UsageError(
      'plan/apply is not supported for the local provider. Use `clawops up` directly.',
    )
  }

  const ctx = buildContext({
    stack: plan.spec.stackName,
    provider: plan.spec.provider,
  })

  const stack = await ctx.getStack()

  await stack.setConfig('instanceType', { value: plan.spec.instanceType })
  if (plan.spec.region) {
    await stack.setConfig('region', { value: plan.spec.region })
  }
  await stack.setConfig('openclawVersion', { value: plan.spec.openclaw.version })

  const start = Date.now()
  const result = await stack.up({ onOutput: opts?.onOutput, signal: opts?.signal })

  const outputs: Record<string, unknown> = Object.fromEntries(
    Object.entries(result.outputs).map(([k, v]) => [k, v.value]),
  )

  const changeSummary: Record<string, number> = {}
  if (result.summary.resourceChanges) {
    for (const [op, count] of Object.entries(result.summary.resourceChanges)) {
      changeSummary[op] = count
    }
  }

  return {
    outputs,
    changeSummary,
    durationMs: Date.now() - start,
  }
}
