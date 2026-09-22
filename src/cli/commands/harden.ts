import { defineCommand } from 'citty'
import process from 'node:process'
import { success, failure, warn, info, chalk } from '../../output/human.js'
import { printJson, jsonOk } from '../../output/json.js'

export default defineCommand({
  meta: {
    name: 'harden',
    description: 'Apply security hardening modules to a deployed stack',
  },
  args: {
    stack:    { type: 'string',  description: 'Target stack name' },
    options:  { type: 'string',  description: 'Comma-separated module IDs to run (default: all defaultOn modules)' },
    list:     { type: 'boolean', description: 'List available modules and exit' },
    'dry-run':{ type: 'boolean', description: 'Check current state without applying changes' },
    yes:      { type: 'boolean', description: 'Skip confirmation prompt' },
    json:     { type: 'boolean', description: 'Emit structured JSON output' },
    tailscale:{ type: 'boolean', description: 'Join the tailnet, verify this machine can reach the host there, then use that address' },
  },
  async run({ args }) {
    const { MODULE_CATALOG, resolveModules, runHardening, formatHardenSummary } = await import('../../harden/index.js')
    const { buildContext } = await import('../context.js')
    const { getConfig } = await import('../../config/store.js')

    // ── --list ────────────────────────────────────────────────────────────────
    if (args.list) {
      process.stdout.write('\nAvailable hardening modules:\n\n')
      for (const mod of MODULE_CATALOG) {
        const on = mod.defaultOn ? chalk.green('ON ') : chalk.dim('off')
        const providers = mod.providers === 'all' ? 'all' : (mod.providers as string[]).join(', ')
        process.stdout.write(
          `  ${on}  ${mod.id.padEnd(28)} ${mod.label}  [${providers}]\n`,
        )
      }
      process.stdout.write('\n')
      return
    }

    // ── Resolve stack + connection info ───────────────────────────────────────
    const config = getConfig()
    if (!config) {
      failure('No clawops config found. Run `clawops init` first.')
      process.exit(1)
    }

    const ctx = buildContext({ stack: args.stack })
    const provider = ctx.adapter.name

    const resolved = resolveModules(MODULE_CATALOG, args.options, provider)
    const tailscaleModule = MODULE_CATALOG.find((m) => m.id === 'tailscale')
    const modules =
      args.tailscale && tailscaleModule && !resolved.some((m) => m.id === 'tailscale')
        ? [...resolved, tailscaleModule]
        : resolved

    if (modules.length === 0) {
      warn('No modules selected for this provider. Use --options to specify modules or --list to see all.')
      return
    }

    if (!args.json) {
      process.stdout.write('\nModules to run:\n')
      for (const mod of modules) {
        const flag = mod.defaultOn ? '' : chalk.yellow(' [opt-in]')
        process.stdout.write(`  · ${mod.label}${flag}\n`)
      }
      process.stdout.write('\n')
    }

    if (!args['dry-run'] && !args.yes && !args.json) {
      const { createInterface } = await import('node:readline/promises')
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      const answer = await rl.question('Apply these hardening modules? [y/N] ')
      rl.close()
      if (!answer.toLowerCase().startsWith('y')) {
        info('Aborted.')
        return
      }
    }

    // ── Get connection info ───────────────────────────────────────────────────
    const ac = new AbortController()
    process.on('SIGINT',  () => ac.abort())
    process.on('SIGTERM', () => ac.abort())

    const { extractBaseOutputs } = await import('../../pulumi/outputs.js')
    const stackObj = await ctx.getStack()
    const outputMap = await stackObj.outputs()
    const outputs: Record<string, unknown> = Object.fromEntries(
      Object.entries(outputMap).map(([k, v]) => [k, v.value]),
    )
    const base = extractBaseOutputs(outputs)
    const conn = ctx.adapter.getConnectionInfo({
      ...base,
      privateKeyPath: config.ssh.keyPath,
      knownHostsPath: config.ssh.knownHostsPath,
    })

    // ── Run modules ───────────────────────────────────────────────────────────
    if (!args.json) {
      process.stdout.write(args['dry-run'] ? 'Checking hardening state...\n\n' : 'Applying hardening...\n\n')
    }

    const results = await runHardening(conn, {
      modules,
      dryRun: args['dry-run'],
      signal: ac.signal,
      onProgress: args.json ? undefined : (r) => {
        const icon = r.error ? chalk.red('✗') : r.applyResult?.changed ? chalk.green('✓') : chalk.dim('·')
        process.stdout.write(`  ${icon}  ${r.module.label}\n`)
      },
    })

    if (args.json) {
      printJson(jsonOk({
        dryRun: args['dry-run'] ?? false,
        results: results.map((r) => ({
          id: r.module.id,
          status: r.checkResult.status,
          changed: r.applyResult?.changed ?? false,
          detail: r.applyResult?.detail ?? r.checkResult.detail,
          error: r.error,
          durationMs: r.durationMs,
        })),
      }))
      return
    }

    process.stdout.write('\n' + formatHardenSummary(results))

    const errors = results.filter((r) => r.error)
    if (errors.length > 0) {
      process.stdout.write('\n')
      for (const r of errors) {
        failure(`${r.module.label}: ${r.error}`)
      }
      process.exit(1)
    }

    if (!args['dry-run']) {
      success('Hardening complete.')
    }

    // ── --tailscale: steps 4 and 5 of WO-34 ─────────────────────────────────
    if (args.tailscale && !args['dry-run']) {
      await cutOverToTailnet(ctx, conn, config)
    }
  },
})

/**
 * Point this stack at its tailnet address, but only once that address is proven.
 *
 * The public connection used here is the one clawops already trusts; the override is written to
 * config only if a fresh session over the tailnet address succeeds against keys pinned through
 * it. On any failure nothing is written and clawops keeps using the public address, which is the
 * property that has to hold before anything is allowed to close it.
 */
async function cutOverToTailnet(
  ctx: import('../context.js').ClawopsContext,
  conn: import('../../providers/types.js').ConnectionInfo,
  config: import('../../config/store.js').ClawopsConfig,
): Promise<void> {
  const { withRemoteExec } = await import('../../harden/index.js')
  const { verifyTailnetAddress } = await import('../../harden/tailscale-cutover.js')
  const { acquireSession } = await import('../../transport/pool.js')
  const { setConfig } = await import('../../config/store.js')

  process.stdout.write('\nVerifying the tailnet address before using it...\n')
  const result = await withRemoteExec(conn, undefined, (exec) =>
    verifyTailnetAddress(conn, {
      exec,
      probe: async (target) => {
        try {
          const { session, release } = await acquireSession({
            host: target.host,
            port: target.port,
            user: target.user,
            privateKeyPath: target.privateKeyPath,
            knownHostsPath: target.knownHostsPath,
          })
          try {
            return (await session.exec('true')).code === 0
          } finally {
            release()
          }
        } catch {
          return false
        }
      },
    }),
  )

  if (!result.ok) {
    failure(result.reason)
    process.exit(1)
  }

  const stack = config.stacks[ctx.stackName]
  if (!stack) {
    failure(`Stack "${ctx.stackName}" is not in config, so the tailnet address could not be recorded.`)
    process.exit(1)
  }
  setConfig({
    ...config,
    stacks: {
      ...config.stacks,
      [ctx.stackName]: {
        ...stack,
        tailscale: {
          ip: result.ip,
          ...(result.hostname ? { hostname: result.hostname } : {}),
          verifiedAt: new Date().toISOString(),
        },
      },
    },
  })
  success(
    `clawops now reaches "${ctx.stackName}" at ${result.ip} over the tailnet ` +
      `(${result.pinned} host key${result.pinned === 1 ? '' : 's'} pinned through the public connection). ` +
      'The public address is still open; nothing has been closed.',
  )
}
