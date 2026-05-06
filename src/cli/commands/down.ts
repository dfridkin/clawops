import { defineCommand } from 'citty'
import process from 'node:process'
import { success, failure, info, spinner } from '../../output/human.js'

export default defineCommand({
  meta: {
    name: 'down',
    description: 'Destroy all provisioned resources for a stack',
  },
  args: {
    stack: { type: 'string', description: 'Target stack name' },
    yes: { type: 'boolean', description: 'Skip confirmation prompt' },
  },
  async run({ args }) {
    const { buildContext } = await import('../context.js')

    const ctx = buildContext(args)
    const confirmed = Boolean(args.yes)

    if (!confirmed) {
      // In non-interactive mode we require --yes
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
