import { defineCommand } from 'citty'
import process from 'node:process'
import { success, failure, info, warn } from '../../output/human.js'
import { printJson, jsonOk } from '../../output/json.js'
import { renderTable } from '../../output/table.js'
import { requireConfig } from '../../config/store.js'
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

    const { checkStackDelete, deleteStackFromConfig, forgetNotice } = await import('../../config/stack-delete.js')
    const check = await checkStackDelete(name, { force: !!args.force })

    if (!check.ok) {
      // Same refusals the clawops_stacks_delete tool gives; only the exit differs.
      if (check.refusal === 'deployed') {
        failure(check.reason)
        process.exit(1)
      }
      throw new UsageError(check.reason)
    }
    for (const w of check.warnings) warn(w)

    warn(forgetNotice(name))

    if (!args.yes) {
      const confirmed = await confirm(`Delete stack "${name}" from config?`)
      if (!confirmed) {
        info('Aborted.')
        return
      }
    }

    const deleted = deleteStackFromConfig(name)
    success(deleted.message)
    if (deleted.newDefaultMessage) info(deleted.newDefaultMessage)
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
