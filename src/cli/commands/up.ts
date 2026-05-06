import { defineCommand } from 'citty'
import process from 'node:process'
import { success, failure, info, spinner } from '../../output/human.js'
import { renderTable } from '../../output/table.js'
import { UsageError } from '../../errors/index.js'

const VALID_INSTANCE_TYPES = ['micro', 'small', 'medium', 'large', 'gpu'] as const

export default defineCommand({
  meta: {
    name: 'up',
    description: 'Provision and deploy an OpenClaw stack',
  },
  args: {
    provider: { type: 'string', description: 'Cloud provider (gcp|aws|azure|local)' },
    region: { type: 'string', description: 'Cloud region' },
    'instance-type': { type: 'string', description: 'Instance size alias (micro|small|medium|large|gpu)' },
    'dry-run': { type: 'boolean', description: 'Preview without applying' },
    'no-wait': { type: 'boolean', description: 'Return immediately without waiting for healthy state' },
    'openclaw-version': { type: 'string', description: "semver or 'stable'/'dev'" },
    stack: { type: 'string', description: 'Target stack name' },
  },
  async run({ args }) {
    const { buildContext } = await import('../context.js')

    const instanceAlias = typeof args['instance-type'] === 'string' ? args['instance-type'] : 'small'
    if (!VALID_INSTANCE_TYPES.includes(instanceAlias as typeof VALID_INSTANCE_TYPES[number])) {
      throw new UsageError(
        `Invalid --instance-type: ${instanceAlias}. Valid values: ${VALID_INSTANCE_TYPES.join(', ')}`,
      )
    }

    const ctx = buildContext(args)
    const isDryRun = Boolean(args['dry-run'])

    // Validate provider credentials before spending time on Pulumi workspace init
    const validation = await ctx.adapter.validateConfig()
    if (!validation.ok) {
      for (const e of validation.errors) failure(e)
      process.exit(3)
    }

    const stack = await ctx.getStack()

    // Set stack config values read by the inline Pulumi program
    const region = typeof args.region === 'string' ? args.region : ctx.adapter.defaultRegion()
    const instanceType = ctx.adapter.normalizeInstanceType(
      instanceAlias as typeof VALID_INSTANCE_TYPES[number],
    )
    const openclawVersion = typeof args['openclaw-version'] === 'string'
      ? args['openclaw-version']
      : 'stable'

    await stack.setConfig('region', { value: region })
    await stack.setConfig('instanceType', { value: instanceType })
    await stack.setConfig('openclawVersion', { value: openclawVersion })

    if (isDryRun) {
      info('Previewing changes (--dry-run)...')
      const preview = await stack.preview({ onOutput: (out) => process.stdout.write(out) })
      process.stdout.write('\n')
      if (preview.changeSummary) {
        const rows = Object.entries(preview.changeSummary)
          .filter(([, count]) => count > 0)
          .map(([op, count]) => [op, String(count)])
        if (rows.length > 0) {
          process.stdout.write(renderTable(['Operation', 'Count'], rows) + '\n')
        }
      }
      success('Preview complete (no resources changed)')
      return
    }

    const spin = spinner(`Deploying stack "${ctx.stackName}"...`)
    try {
      const result = await stack.up({
        onOutput: (out) => {
          spin.text = out.trim() || spin.text
        },
      })
      spin.succeed(`Stack "${ctx.stackName}" deployed`)

      // Show key outputs
      const outputs = result.outputs
      if (outputs['publicIp']) {
        info(`Public IP:   ${outputs['publicIp'].value}`)
      }
      if (outputs['gatewayUrl']) {
        info(`Gateway URL: ${outputs['gatewayUrl'].value}`)
      }
    } catch (err) {
      spin.fail('Deployment failed')
      throw err
    }
  },
})
