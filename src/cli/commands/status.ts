import { defineCommand } from 'citty'
import process from 'node:process'
import { renderTable } from '../../output/table.js'
import { printJson, jsonOk } from '../../output/json.js'
import { info } from '../../output/human.js'
import type { ClawopsContext } from '../context.js'
import {
  CHECK_FAILED, handoffBanner, handoffSummary, type HandoffsRead,
} from '../../hostagent/operator.js'

export default defineCommand({
  meta: {
    name: 'status',
    description: 'Show current stack status: outputs, region, provisioned time',
  },
  args: {
    stack: { type: 'string', description: 'Target stack name' },
    json: { type: 'boolean', description: 'Emit JSON' },
  },
  async run({ args }) {
    const { buildContext } = await import('../context.js')

    const ctx = buildContext(args)

    // ── Local provider path ────────────────────────────────────────────────────
    if (ctx.adapter.name === 'local') {
      const state = ctx.localState

      if (Boolean(args.json)) {
        if (state) {
          printJson(jsonOk({ stack: ctx.stackName, ...state, ...handoffsJson(await handoffs(ctx)) }))
        } else {
          printJson(jsonOk({ stack: ctx.stackName, status: 'not bootstrapped' }))
        }
        return
      }

      const rows: string[][] = [['Stack', ctx.stackName]]
      if (state) {
        rows.push(['Provider', 'local'])
        rows.push(['Host', state.sshHost])
        rows.push(['SSH', `${state.sshUser}@${state.sshHost}:${state.sshPort}`])
        rows.push(['Gateway URL', state.gatewayUrl])
        rows.push(['Bootstrapped', state.provisionedAt])
      } else {
        rows.push(['Status', 'not bootstrapped (run `clawops up`)'])
      }

      process.stdout.write('\n' + renderTable(['Field', 'Value'], rows) + '\n\n')
      if (state) printBanner(ctx.stackName, await handoffs(ctx))
      return
    }

    // ── Cloud provider path (Pulumi) ───────────────────────────────────────────
    const { extractBaseOutputs } = await import('../../pulumi/outputs.js')

    const stack = await ctx.getStack()
    const outputMap = await stack.outputs()
    const outputs: Record<string, unknown> = Object.fromEntries(
      Object.entries(outputMap).map(([k, v]) => [k, v.value]),
    )

    const deployed = Boolean(outputs['publicIp'])

    if (Boolean(args.json)) {
      printJson(jsonOk({ stack: ctx.stackName, ...outputs, ...(deployed ? handoffsJson(await handoffs(ctx)) : {}) }))
      return
    }

    const rows: string[][] = []
    try {
      const base = extractBaseOutputs(outputs)
      rows.push(['Stack', ctx.stackName])
      rows.push(['Provider', ctx.config.stacks[ctx.stackName]?.provider ?? '—'])
      rows.push(['Region', base.region])
      rows.push(['Public IP', base.publicIp])
      rows.push(['Gateway URL', base.gatewayUrl])
      rows.push(['SSH', `${base.sshUser}@${base.sshHost}:${base.sshPort}`])
      rows.push(['Provisioned', base.provisionedAt])
    } catch {
      rows.push(['Stack', ctx.stackName])
      rows.push(['Status', 'not deployed (run `clawops up`)'])
    }

    process.stdout.write('\n' + renderTable(['Field', 'Value'], rows) + '\n\n')
    if (deployed) printBanner(ctx.stackName, await handoffs(ctx))
  },
})

/** Requests from the stack's host agent (ADR 0014 §3), read over SSH. */
async function handoffs(ctx: ClawopsContext): Promise<HandoffsRead> {
  const { pendingOnHost } = await import('../../hostagent/operator.js')
  return pendingOnHost(ctx)
}

function handoffsJson(read: HandoffsRead): Record<string, unknown> {
  if (!read.ok) return { pendingHandoffsError: `${CHECK_FAILED}: ${read.error}` }
  return read.value.length > 0 ? { pendingHandoffs: read.value.map(handoffSummary) } : {}
}

/**
 * Printed after the table, where the operator already looks. A host that could not be asked
 * gets a note: silence there would read as "no requests".
 */
function printBanner(stack: string, read: HandoffsRead): void {
  if (!read.ok) {
    info(`${CHECK_FAILED}: ${read.error}`)
    return
  }
  if (read.value.length > 0) process.stdout.write(handoffBanner(stack, read.value) + '\n\n')
}
