import { defineCommand } from 'citty'
import process from 'node:process'
import { success, failure, info, warn } from '../../output/human.js'
import { printJson, jsonOk } from '../../output/json.js'
import { renderTable } from '../../output/table.js'
import { requireConfig, setConfig } from '../../config/store.js'
import { UsageError } from '../../errors/index.js'

export default defineCommand({
  meta: {
    name: 'stacks',
    description: 'Manage clawops stacks (list | delete <name>)',
  },
  args: {
    json:  { type: 'boolean', description: 'Emit JSON (for list)' },
    yes:   { type: 'boolean', description: 'Skip confirmation prompt on delete' },
    force: { type: 'boolean', description: 'Skip safety checks (allow deleting default or still-deployed stacks)' },
  },
  async run({ args }) {
    const [action, name] = (args._ ?? []) as string[]

    if (!action || !['list', 'delete'].includes(action)) {
      failure('Usage: clawops stacks <list | delete <name>>')
      process.exit(2)
    }

    if (action === 'list') {
      const config = requireConfig()
      const defaultStack = config.defaults.stack
      const rows = Object.entries(config.stacks).map(([n, s]) => [
        n === defaultStack ? `${n} *` : n,
        s.provider,
        s.region ?? '—',
        s.stateUrl,
      ])

      if (args.json) {
        const data = Object.entries(config.stacks).map(([n, s]) => ({
          name: n,
          provider: s.provider,
          region: s.region ?? null,
          stateUrl: s.stateUrl,
          isDefault: n === defaultStack,
        }))
        printJson(jsonOk({ stacks: data, default: defaultStack }))
      } else if (rows.length === 0) {
        info('No stacks configured.')
      } else {
        process.stdout.write(
          '\n' +
            renderTable(
              ['Name', 'Provider', 'Region', 'State URL'],
              rows,
            ) +
            '\n\n',
        )
        info('* = default stack')
      }
      return
    }

    // delete
    if (!name) {
      failure('Usage: clawops stacks delete <name>')
      process.exit(2)
    }

    const config = requireConfig()

    if (!(name in config.stacks)) {
      throw new UsageError(`Stack "${name}" not found in config.`)
    }

    const stackNames = Object.keys(config.stacks)
    if (stackNames.length === 1) {
      throw new UsageError(
        `Cannot delete the only remaining stack "${name}". ` +
          'Add another stack first or run `clawops destroy` to tear down resources.',
      )
    }

    if (name === config.defaults.stack && !args.force) {
      throw new UsageError(
        `"${name}" is the default stack. Use --force to delete it ` +
          '(clawops will switch the default to another stack).',
      )
    }

    let isDeployed = false
    if (!args.force) {
      try {
        const { buildContext } = await import('../context.js')
        const ctx = buildContext({ stack: name })
        if (ctx.adapter.name === 'local') {
          isDeployed = !!ctx.localState
        } else {
          const stack = await ctx.getStack()
          const outputMap = await stack.outputs()
          const outputs = Object.fromEntries(
            Object.entries(outputMap).map(([k, v]) => [k, (v as { value: unknown }).value]),
          )
          isDeployed = !!outputs['publicIp']
        }
      } catch {
        warn(`Could not verify deployment status for "${name}" — proceeding anyway.`)
      }
    }

    if (isDeployed) {
      failure(
        `Stack "${name}" is still deployed. ` +
          `Run \`clawops down --stack ${name}\` first to destroy cloud resources, ` +
          `or pass --force to remove from registry only.`,
      )
      process.exit(1)
    }

    warn(
      `This removes "${name}" from clawops config only. ` +
        'Cloud resources are NOT destroyed. ' +
        'Run `clawops destroy --stack ' + name + '` first if you want to remove cloud resources.',
    )

    if (!args.yes) {
      const confirmed = await confirm(`Delete stack "${name}" from config?`)
      if (!confirmed) {
        info('Aborted.')
        return
      }
    }

    const updated = { ...config }
    const newStacks = { ...config.stacks }
    delete newStacks[name]
    updated.stacks = newStacks

    // If we're deleting the default, pick the first remaining stack
    if (name === config.defaults.stack) {
      updated.defaults = { ...config.defaults, stack: Object.keys(newStacks)[0]! }
    }

    setConfig(updated)
    success(`Stack "${name}" removed from config.`)

    if (name === config.defaults.stack) {
      info(`Default stack switched to "${updated.defaults.stack}".`)
    }
  },
})

async function confirm(message: string): Promise<boolean> {
  const { createInterface } = await import('node:readline/promises')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question(`${message} (y/N) `)
    return answer.trim().toLowerCase() === 'y'
  } finally {
    rl.close()
  }
}
