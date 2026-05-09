// _command-template.ts — copy this to src/cli/commands/<verb>.ts and fill in the blanks.
// Search for TODO_ to find every placeholder that must be replaced before committing.
//
// Checklist before opening a PR:
//   1. Rename all TODO_ identifiers and fill in real values
//   2. Register the command in src/cli/index.ts → subCommands
//   3. Add a matching MCP tool in spec/mcp-tools.yaml if agent-accessible, then `pnpm gen:schemas`
//   4. Add tests in tests/cli/<verb>.test.ts
//   5. Update README.md commands table + relevant docs section
//   6. Add a changeset: pnpm changeset

import { defineCommand } from 'citty'
import process from 'node:process'
import { success, failure, info } from '../../output/human.js'
import { printJson, jsonOk } from '../../output/json.js'

export default defineCommand({
  meta: {
    name: 'TODO_VERB',
    description: 'TODO: one sentence describing what the command does',
  },
  args: {
    // Use type: 'string' | 'boolean' | 'number' for each flag.
    // Add required: true only for positional arguments the command cannot infer.
    stack:     { type: 'string',  description: 'Target stack name' },
    json:      { type: 'boolean', description: 'Emit structured JSON output' },
    'dry-run': { type: 'boolean', description: 'Show what would happen without doing it' },
  },
  async run({ args }) {
    // Lazy-import heavy dependencies so the CLI starts fast even when unused.
    const { buildContext } = await import('../context.js')

    const ctx = buildContext(args)

    // Set up cancellation so Ctrl-C cleans up gracefully (R13).
    const ac = new AbortController()
    process.on('SIGINT',  () => ac.abort())
    process.on('SIGTERM', () => ac.abort())

    // ── Dry-run guard ────────────────────────────────────────────────────────────
    if (args['dry-run']) {
      info('Dry run — no changes made.')
      return
    }

    // ── Core logic ──────────────────────────────────────────────────────────────
    // Rules:
    //   - All output via output/human.ts or output/json.ts — never console.log
    //   - Pass ac.signal through every network/SSH/Pulumi call (R13)
    //   - Return Result<T, E> from library functions; throw only here at the CLI boundary
    //   - JSON mode: emit jsonOk(data) with a typed data shape, no human text

    try {
      // TODO: implement core logic here
      // const result = await doTheThing(ctx, ac.signal)
      void ctx  // remove when ctx is actually used

      if (args.json) {
        printJson(jsonOk({ /* TODO: structured result */ }))
      } else {
        success('TODO_VERB complete.')
      }
    } catch (err) {
      failure(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }
  },
})
