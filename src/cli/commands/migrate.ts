// `clawops migrate` — move a 1.x deployment onto the 2.0 runtime contract.
//
// The sequence lives in src/openclaw/migrate.ts and everything around it — target guard,
// connection, the effects of each step, how the outcome reads — in src/openclaw/migrate-flow.ts,
// which the clawops_migrate MCP tool runs too. This only renders. See migrate.ts for why the
// order is what it is — three assumptions in the original plan were wrong, and each was found
// by running a real migration rather than reasoning about one.

import { defineCommand } from 'citty'
import process from 'node:process'
import { spinner, success, failure, info, warn } from '../../output/human.js'

export default defineCommand({
  meta: {
    name: 'migrate',
    description: 'Move a 1.x OpenClaw deployment onto the 2.0 runtime contract',
  },
  args: {
    stack: { type: 'string', description: 'Target stack name' },
    'openclaw-version': { type: 'string', description: 'OpenClaw 2.x version to migrate to' },
    yes: { type: 'boolean', description: 'Skip the confirmation prompt' },
  },
  async run({ args }) {
    const { prepareMigration, runMigration, migrationQuestion } = await import('../../openclaw/migrate-flow.js')

    const target = await prepareMigration({
      stack: typeof args.stack === 'string' ? args.stack : undefined,
      openclawVersion: typeof args['openclaw-version'] === 'string' ? args['openclaw-version'] : undefined,
    })

    // --yes was declared and never read: the CLI migrated without asking while the MCP tool
    // asked. Asking is part of what the command does, so both surfaces ask the same question.
    if (!args.yes) {
      const inquirer = (await import('inquirer')).default
      const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([{
        type: 'confirm',
        name: 'confirmed',
        message: migrationQuestion(target),
        default: false,
      }])
      if (!confirmed) { info('Aborted. Nothing was changed.'); return }
    }

    const ac = new AbortController()
    process.on('SIGINT', () => ac.abort())

    let spin: ReturnType<typeof spinner> | undefined
    try {
      const result = await runMigration(target, {
        signal: ac.signal,
        onStep: (text) => {
          if (spin) spin.text = text
          else spin = spinner(text)
        },
      })
      spin?.stop()

      const render = { success, info, warn, failure }
      for (const line of result.lines) render[line.level](line.text)
      if (result.outcome.kind !== 'migrated') process.exit(result.exitCode)
    } finally {
      spin?.stop()
    }
  },
})
