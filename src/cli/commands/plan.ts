import { defineCommand } from 'citty'
import process from 'node:process'
import { writeFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { success, spinner } from '../../output/human.js'
import { renderTable } from '../../output/table.js'
import { UsageError } from '../../errors/index.js'

export default defineCommand({
  meta: {
    name: 'plan',
    description: 'Generate a Maker deploy plan without applying it',
  },
  args: {
    provider:          { type: 'string', description: 'Cloud provider (aws|gcp|azure)' },
    stack:             { type: 'string', description: 'Target stack name' },
    region:            { type: 'string', description: 'Cloud region' },
    'instance-type':   { type: 'string', description: 'Instance size alias (micro|small|medium|large|gpu)' },
    'openclaw-version':{ type: 'string', description: "semver or 'stable'/'dev'" },
    out:               { type: 'string', description: 'Write plan JSON to this absolute path (default: stdout)' },
  },
  async run({ args }) {
    const { buildContext } = await import('../context.js')
    const { generatePlan } = await import('../../plan/generate.js')

    const ctx = buildContext(args)

    if (ctx.adapter.name === 'local') {
      throw new UsageError(
        'plan/apply is not supported for the local provider. Use `clawops up` directly.',
      )
    }

    const provider = ctx.adapter.name as 'aws' | 'gcp' | 'azure'
    const outPath = typeof args.out === 'string' ? args.out : undefined

    if (outPath && !isAbsolute(outPath)) {
      throw new UsageError('--out path must be absolute (R7). Use an absolute path like /tmp/plan.json.')
    }

    const abortController = new AbortController()
    process.on('SIGINT', () => abortController.abort())
    process.on('SIGTERM', () => abortController.abort())

    const spin = spinner('Generating plan…')
    let plan: Awaited<ReturnType<typeof generatePlan>>
    try {
      plan = await generatePlan(
        {
          stackName: ctx.stackName,
          provider,
          region: typeof args.region === 'string' ? args.region : undefined,
          instanceType: typeof args['instance-type'] === 'string' ? args['instance-type'] : undefined,
          openclawVersion: typeof args['openclaw-version'] === 'string' ? args['openclaw-version'] : undefined,
        },
        { signal: abortController.signal },
      )
      spin.succeed('Plan generated')
    } catch (err) {
      spin.fail('Plan generation failed')
      throw err
    }

    const planJson = JSON.stringify(plan, null, 2)

    if (outPath) {
      writeFileSync(outPath, planJson + '\n', 'utf-8')
      success(`Plan written to ${outPath}`)
    } else {
      process.stdout.write(planJson + '\n')
    }

    // Diff summary — always to stderr so it doesn't pollute stdout JSON
    if (plan.diff) {
      const { create, update, delete: del, totalChanges } = plan.diff
      process.stderr.write(
        `\nChanges: ${create.length} to create, ${update.length} to update, ${del.length} to delete (${totalChanges} total)\n`,
      )
      const rows: string[][] = [
        ...create.map((r) => ['+', r.type, r.name ?? '']),
        ...update.map((r) => ['~', r.resource.type, r.resource.name ?? '']),
        ...del.map((r) => ['-', r.type, r.name ?? '']),
      ]
      if (rows.length > 0) {
        process.stderr.write(renderTable(['Op', 'Resource Type', 'Name'], rows) + '\n')
      }
    } else {
      process.stderr.write('(diff unavailable — preview could not run against this stack)\n')
    }
  },
})
