import { defineCommand } from 'citty'
import process from 'node:process'
import { renderTable } from '../../output/table.js'
import { printJson, jsonOk } from '../../output/json.js'

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
        printJson(state
          ? jsonOk({ stack: ctx.stackName, ...state })
          : jsonOk({ stack: ctx.stackName, status: 'not bootstrapped' }),
        )
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
      return
    }

    // ── Cloud provider path (Pulumi) ───────────────────────────────────────────
    const { extractBaseOutputs } = await import('../../pulumi/outputs.js')

    const stack = await ctx.getStack()
    const outputMap = await stack.outputs()
    const outputs: Record<string, unknown> = Object.fromEntries(
      Object.entries(outputMap).map(([k, v]) => [k, v.value]),
    )

    if (Boolean(args.json)) {
      printJson(jsonOk({ stack: ctx.stackName, ...outputs }))
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
  },
})
