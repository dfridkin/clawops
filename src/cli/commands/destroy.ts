import { defineCommand } from 'citty'
import process from 'node:process'
import type { ClawopsContext } from '../context.js'
import { createInterface } from 'node:readline/promises'
import { success, info, spinner } from '../../output/human.js'
import { renderTable } from '../../output/table.js'
import { UsageError } from '../../errors/index.js'

export default defineCommand({
  meta: {
    name: 'destroy',
    description: 'Destroy all resources in a stack (irreversible)',
  },
  args: {
    stack:     { type: 'string',  description: 'Target stack name' },
    yes:       { type: 'boolean', description: 'Skip confirmation prompt' },
    'dry-run': { type: 'boolean', description: 'Show what would be destroyed without destroying' },
  },
  async run({ args }) {
    const { buildContext } = await import('../context.js')

    const ctx = buildContext(args)

    if (ctx.adapter.name === 'local') {
      throw new UsageError(
        'Local provider stacks cannot be destroyed via `clawops destroy`. ' +
        'Use `clawops down --yes` to remove a local stack.',
      )
    }

    const stack = await ctx.getStack()

    if (args['dry-run']) {
      info(`Dry run — would destroy stack "${ctx.stackName}" (${ctx.adapter.name})`)
      try {
        const outputMap = await stack.outputs()
        const rows = Object.entries(outputMap).map(([k, v]) => [k, String(v.value ?? '')])
        if (rows.length > 0) {
          process.stdout.write('\nCurrent outputs that would be lost:\n')
          process.stdout.write(renderTable(['Output', 'Value'], rows) + '\n')
        }
      } catch {
        // outputs may not be available on undeployed stacks — not fatal
      }
      process.stdout.write(`\nPass --yes to proceed with destruction.\n`)
      return
    }

    if (!args.yes) {
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      const answer = await rl.question(
        `Destroy stack "${ctx.stackName}"? This is irreversible. (y/N) `,
      )
      rl.close()
      if (answer.trim().toLowerCase() !== 'y') {
        process.stdout.write('Aborted.\n')
        process.exit(0)
      }
    }

    const abortController = new AbortController()
    process.on('SIGINT', () => abortController.abort())
    process.on('SIGTERM', () => abortController.abort())

    // Read the host before it is gone: a destroyed stack has no outputs to ask afterwards.
    const doomedHost = await hostOf(stack, ctx)

    const spin = spinner(`Destroying stack "${ctx.stackName}"…`)
    try {
      await stack.destroy({
        onOutput: (out) => { spin.text = out.trim() || spin.text },
      })
      spin.succeed(`Stack "${ctx.stackName}" destroyed`)
      success('All resources have been removed.')
    } catch (err) {
      spin.fail('Destroy failed')
      throw err
    }

    // A cloud provider hands addresses back out. Deploy again and the new instance can land on
    // the address this one just released, with a different host key — and trust-on-first-use
    // then refuses to connect, correctly, over a machine that no longer exists. The pinned key
    // is stale the moment the instance it belongs to is destroyed, so this is where it goes.
    if (doomedHost) {
      const { forgetHost } = await import('../../transport/known-hosts-file.js')
      const removed = forgetHost(
        expandHome(ctx.config.ssh.knownHostsPath),
        doomedHost.host,
        doomedHost.port,
      )
      if (removed) info(`Forgot the host key for ${doomedHost.host} — its instance is gone.`)
    }
  },
})

/** Where the stack's instance was, while its outputs still exist. */
async function hostOf(
  stack: { outputs(): Promise<Record<string, { value: unknown }>> },
  ctx: ClawopsContext,
): Promise<{ host: string; port: number } | undefined> {
  try {
    const outputMap = await stack.outputs()
    const raw = Object.fromEntries(Object.entries(outputMap).map(([k, v]) => [k, v.value]))
    const { extractBaseOutputs } = await import('../../pulumi/outputs.js')
    const conn = ctx.adapter.getConnectionInfo({
      ...extractBaseOutputs(raw),
      privateKeyPath: ctx.config.ssh.keyPath,
      knownHostsPath: ctx.config.ssh.knownHostsPath,
    })
    return conn.host ? { host: conn.host, port: conn.port } : undefined
  } catch {
    // A stack with no outputs was never deployed, or is already gone. Nothing to forget.
    return undefined
  }
}

/** `~` in a configured path is the operator's home, not a directory called "~". */
function expandHome(p: string): string {
  return p.replace(/^~/, process.env['HOME'] ?? '~')
}
