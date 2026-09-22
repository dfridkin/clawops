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
    const doomedHosts = await hostsOf(stack, ctx)

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
    const { forgetHost } = await import('../../transport/known-hosts-file.js')
    for (const doomed of doomedHosts) {
      const removed = forgetHost(expandHome(ctx.config.ssh.knownHostsPath), doomed.host, doomed.port)
      if (removed) info(`Forgot the host key for ${doomed.host} — its instance is gone.`)
    }
  },
})

/**
 * Every address the stack's instance was reachable at, while its outputs still exist.
 *
 * One, until a stack has a tailnet override; then two, and both keys go stale together. This used
 * to ask the adapter where the host was, and once the override redirects the adapter to the
 * tailnet address that is the only one it answers with. Destroying a stack on its tailnet then
 * forgot the tailnet key and left the public address pinned, for an instance that no longer
 * exists, on an address the cloud hands straight back out. Measured on AWS: 34.200.67.239 stayed
 * pinned after its instance was gone.
 *
 * The public address is read from the outputs themselves, which the override does not touch.
 */
async function hostsOf(
  stack: { outputs(): Promise<Record<string, { value: unknown }>> },
  ctx: ClawopsContext,
): Promise<Array<{ host: string; port: number }>> {
  const hosts: Array<{ host: string; port: number }> = []
  try {
    const outputMap = await stack.outputs()
    const raw = Object.fromEntries(Object.entries(outputMap).map(([k, v]) => [k, v.value]))
    const { extractBaseOutputs } = await import('../../pulumi/outputs.js')
    const base = extractBaseOutputs(raw)
    if (base.sshHost) hosts.push({ host: base.sshHost, port: base.sshPort })
  } catch {
    // A stack with no outputs was never deployed, or is already gone. Nothing public to forget.
  }
  const tailnet = ctx.config.stacks?.[ctx.stackName]?.tailscale
  if (tailnet?.ip) {
    const port = hosts[0]?.port ?? 22
    if (!hosts.some((h) => h.host === tailnet.ip)) hosts.push({ host: tailnet.ip, port })
  }
  return hosts
}

/** `~` in a configured path is the operator's home, not a directory called "~". */
function expandHome(p: string): string {
  return p.replace(/^~/, process.env['HOME'] ?? '~')
}
