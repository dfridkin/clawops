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
    'tailscale-revert': { type: 'boolean', description: 'Take the host off its tailnet and go back to its public address. A private-only stack must be reopened with a plan first' },
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

    if (args['tailscale-revert']) {
      await revertTailnet(ctx, config, { yes: args.yes === true })
      return
    }

    const { makeTailscaleModule } = await import('../../harden/index.js')
    /*
     * The catalog's Tailscale module has no stack name, because the module contract hands a
     * module an exec and nothing else. Left as it is, the machine joins under the host's own
     * name: on AWS that was `clawops-ip-10-0-1-179`, which tells an operator looking at their
     * tailnet nothing. Here the stack is known, so the module is built with it.
     */
    const forStack = makeTailscaleModule(ctx.stackName)
    const resolved = resolveModules(MODULE_CATALOG, args.options, provider).map((m) =>
      m.id === 'tailscale' ? forStack : m,
    )
    const modules =
      args.tailscale && !resolved.some((m) => m.id === 'tailscale') ? [...resolved, forStack] : resolved

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
  const { verifyTailnetAddress, probeSsh } = await import('../../harden/tailscale-cutover.js')
  const { setConfig } = await import('../../config/store.js')

  process.stdout.write('\nVerifying the tailnet address before using it...\n')
  const result = await withRemoteExec(conn, undefined, (exec) =>
    verifyTailnetAddress(conn, {
      exec,
      probe: (target) => probeSsh(target),
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

/**
 * Undo `--tailscale`: leave the tailnet, and point clawops back at the public address.
 *
 * Everything here runs over the public address, found by building a context that ignores the
 * override. Leaving the tailnet over the tailnet cuts the connection doing it, and on AWS that
 * hung for eight minutes. So the public address has to answer first, and on a private-only
 * stack it does not: the ports are closed, and reopening them is an infrastructure change, which
 * goes through a plan. Revert says so and changes nothing, rather than stranding the stack.
 */
async function revertTailnet(
  ctx: import('../context.js').ClawopsContext,
  config: import('../../config/store.js').ClawopsConfig,
  opts: { yes: boolean },
): Promise<void> {
  const override = config.stacks[ctx.stackName]?.tailscale
  if (!override) {
    info(`Stack "${ctx.stackName}" is not using a tailnet address; nothing to revert.`)
    return
  }

  const { buildContext } = await import('../context.js')
  const { extractBaseOutputs } = await import('../../pulumi/outputs.js')
  const { probeSsh, leaveTailnet } = await import('../../harden/tailscale-cutover.js')
  const { withRemoteExec } = await import('../../harden/index.js')
  const { getConfig, setConfig } = await import('../../config/store.js')
  const { forgetHost } = await import('../../transport/known-hosts-file.js')

  const direct = buildContext({ stack: ctx.stackName, ignoreTailnet: true })
  const outputMap = await (await direct.getStack()).outputs()
  const raw = Object.fromEntries(Object.entries(outputMap).map(([k, v]) => [k, v.value]))
  const publicConn = direct.adapter.getConnectionInfo({
    ...extractBaseOutputs(raw),
    privateKeyPath: config.ssh.keyPath,
    knownHostsPath: config.ssh.knownHostsPath,
  })

  if (!(await probeSsh(publicConn))) {
    failure(
      override.privateOnly
        ? `"${ctx.stackName}" is private-only: its public ports are closed, so there is no way to ` +
            'leave the tailnet without losing the host. Reopen SSH first, then run this again:\n' +
            `  clawops plan --stack ${ctx.stackName} --ssh-cidr auto --out <abs-path>/plan.json\n` +
            '  clawops apply <abs-path>/plan.json\n' +
            'Nothing was changed.'
        : `This machine cannot reach "${ctx.stackName}" at its public address ${publicConn.host}, ` +
            'and leaving the tailnet would leave no way in. Nothing was changed.',
    )
    process.exit(1)
  }

  if (!opts.yes) {
    const { createInterface } = await import('node:readline/promises')
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = await rl.question(
      `Take "${ctx.stackName}" off the tailnet (${override.ip}) and use ${publicConn.host} again? [y/N] `,
    )
    rl.close()
    if (!answer.toLowerCase().startsWith('y')) {
      info('Aborted.')
      return
    }
  }

  const left = await withRemoteExec(publicConn, undefined, (exec) => leaveTailnet(exec))
  if (!left.ok) {
    failure(`${left.reason}. clawops still uses the tailnet address; nothing else was changed.`)
    process.exit(1)
  }

  // Re-read: the probe and the logout took seconds, and config is the operator's file.
  const fresh = getConfig() ?? config
  const stack = fresh.stacks[ctx.stackName]
  if (stack) {
    const { tailscale: _dropped, ...rest } = stack
    void _dropped
    setConfig({ ...fresh, stacks: { ...fresh.stacks, [ctx.stackName]: rest } })
  }
  forgetHost(expandHome(config.ssh.knownHostsPath), override.ip, publicConn.port)

  success(
    `"${ctx.stackName}" has left the tailnet; clawops reaches it at ${publicConn.host} again ` +
      `(the pinned key for ${override.ip} was forgotten).`,
  )
}

function expandHome(p: string): string {
  return p.startsWith('~') ? p.replace(/^~/, process.env['HOME'] ?? '~') : p
}
