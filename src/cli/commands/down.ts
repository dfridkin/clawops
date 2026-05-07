import { defineCommand } from 'citty'
import process from 'node:process'
import { success, failure, info, spinner } from '../../output/human.js'
import { renderTable } from '../../output/table.js'

export default defineCommand({
  meta: {
    name: 'down',
    description: 'Destroy all provisioned resources for a stack',
  },
  args: {
    stack:     { type: 'string',  description: 'Target stack name' },
    yes:       { type: 'boolean', description: 'Skip confirmation prompt' },
    'dry-run': { type: 'boolean', description: 'Show what would be destroyed without destroying' },
  },
  async run({ args }) {
    const { buildContext } = await import('../context.js')

    const ctx = buildContext(args)

    if (args['dry-run']) {
      info(`Dry run — would destroy stack "${ctx.stackName}"`)
      try {
        const stack = await ctx.getStack()
        const outputMap = await stack.outputs()
        const rows = Object.entries(outputMap).map(([k, v]) => [k, String(v.value ?? '')])
        if (rows.length > 0) {
          process.stdout.write('\nCurrent outputs that would be lost:\n')
          process.stdout.write(renderTable(['Output', 'Value'], rows) + '\n')
        }
      } catch {
        // outputs unavailable — not fatal
      }
      process.stdout.write('\nPass --yes to proceed with destruction.\n')
      return
    }

    const confirmed = Boolean(args.yes)

    if (!confirmed) {
      failure(
        `This will destroy all resources in stack "${ctx.stackName}". ` +
          'Pass --yes to confirm.',
      )
      process.exit(1)
    }

    info(`Destroying stack "${ctx.stackName}"...`)

    const stack = await ctx.getStack()
    const spin = spinner('Running destroy...')

    try {
      await stack.destroy({ onOutput: (out) => { spin.text = out.trim() || spin.text } })
      spin.succeed(`Stack "${ctx.stackName}" destroyed`)
      success('All resources have been removed.')
    } catch (err) {
      spin.fail('Destroy failed')
      throw err
    }
  },
})
