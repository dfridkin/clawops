import { defineCommand } from 'citty'
import process from 'node:process'
import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { success, info, spinner } from '../../output/human.js'
import { renderTable } from '../../output/table.js'
import { UsageError } from '../../errors/index.js'

export default defineCommand({
  meta: {
    name: 'apply',
    description: 'Apply a Maker plan JSON produced by `clawops plan`',
  },
  args: {
    yes:       { type: 'boolean', description: 'Skip confirmation prompt' },
    'dry-run': { type: 'boolean', description: 'Validate plan and show diff without applying' },
  },
  async run({ args }) {
    const { validatePlan } = await import('../../plan/validate.js')
    const { applyPlan } = await import('../../plan/apply.js')

    const planPath = (args._ as string[] | undefined)?.[0]
    if (!planPath) {
      throw new UsageError('Usage: clawops apply <plan.json>')
    }
    if (!isAbsolute(planPath)) {
      throw new UsageError(`Plan path must be absolute (R7). Got: ${planPath}`)
    }

    let raw: string
    try {
      raw = readFileSync(planPath, 'utf-8')
    } catch {
      throw new UsageError(`Cannot read plan file: ${planPath}`)
    }

    let plan: unknown
    try {
      plan = JSON.parse(raw)
    } catch {
      throw new UsageError(`Plan file is not valid JSON: ${planPath}`)
    }

    const validation = validatePlan(plan)
    if (!validation.ok) {
      throw new UsageError(`Invalid plan:\n${validation.errors.join('\n')}`)
    }

    // validatePlan asserts shape; safe to access typed fields
    const typedPlan = plan as import('../../plan/generate.js').DeployPlan

    if (typedPlan.spec.provider === 'local') {
      throw new UsageError(
        'plan/apply is not supported for the local provider. Use `clawops up` directly.',
      )
    }

    info(`Applying plan: ${planPath}`)
    if (typedPlan.diff) {
      const { create, update, delete: del } = typedPlan.diff
      process.stdout.write(
        `  ${create.length} to create, ${update.length} to update, ${del.length} to delete\n`,
      )
      const rows: string[][] = [
        ...create.map((r) => ['+', r.type, r.name ?? '']),
        ...update.map((r) => ['~', r.resource.type, r.resource.name ?? '']),
        ...del.map((r) => ['-', r.type, r.name ?? '']),
      ]
      if (rows.length > 0) {
        process.stdout.write(renderTable(['Op', 'Resource Type', 'Name'], rows) + '\n')
      }
    }

    if (args['dry-run']) {
      info('Dry run — plan is valid. Pass --yes (without --dry-run) to apply.')
      return
    }

    if (!args.yes) {
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      const answer = await rl.question('Continue? (y/N) ')
      rl.close()
      if (answer.trim().toLowerCase() !== 'y') {
        process.stdout.write('Aborted.\n')
        process.exit(0)
      }
    }

    const abortController = new AbortController()
    process.on('SIGINT', () => abortController.abort())
    process.on('SIGTERM', () => abortController.abort())

    const spin = spinner(`Applying plan for stack "${typedPlan.spec.stackName}"…`)
    try {
      const result = await applyPlan(typedPlan, {
        onOutput: (line) => { spin.text = line.trim() || spin.text },
        signal: abortController.signal,
      })
      spin.succeed(`Stack "${typedPlan.spec.stackName}" applied`)

      const summaryRows = Object.entries(result.changeSummary)
        .filter(([, count]) => count > 0)
        .map(([op, count]) => [op, String(count)])
      if (summaryRows.length > 0) {
        process.stdout.write(renderTable(['Operation', 'Count'], summaryRows) + '\n')
      }

      if (result.outputs['gatewayUrl']) {
        info(`Gateway URL: ${result.outputs['gatewayUrl']}`)
      }
      if (result.outputs['publicIp']) {
        info(`Public IP:   ${result.outputs['publicIp']}`)
      }

      success(`Done in ${(result.durationMs / 1000).toFixed(1)}s`)
    } catch (err) {
      spin.fail('Apply failed')
      throw err
    }
  },
})
