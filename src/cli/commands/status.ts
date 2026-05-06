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
    const { extractBaseOutputs } = await import('../../pulumi/outputs.js')

    const ctx = buildContext(args)
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
