import { defineCommand } from 'citty'
import process from 'node:process'
import { readFileSync } from 'node:fs'
import { success, failure, info, spinner } from '../../output/human.js'
import { renderTable } from '../../output/table.js'
import { UsageError } from '../../errors/index.js'

const VALID_INSTANCE_TYPES = ['micro', 'small', 'medium', 'large', 'gpu'] as const

export default defineCommand({
  meta: {
    name: 'up',
    description: 'Provision and deploy an OpenClaw stack',
  },
  args: {
    provider: { type: 'string', description: 'Cloud provider (gcp|aws|azure|local)' },
    region: { type: 'string', description: 'Cloud region' },
    'instance-type': { type: 'string', description: 'Instance size alias (micro|small|medium|large|gpu)' },
    'dry-run': { type: 'boolean', description: 'Preview without applying' },
    'no-wait': { type: 'boolean', description: 'Return immediately without waiting for healthy state' },
    'openclaw-version': { type: 'string', description: "semver or 'stable'/'dev'" },
    stack: { type: 'string', description: 'Target stack name' },
    config: { type: 'string', description: 'Path to openclaw config overlay JSON (local provider only)' },
  },
  async run({ args }) {
    const { buildContext } = await import('../context.js')

    const ctx = buildContext(args)
    const openclawVersion = typeof args['openclaw-version'] === 'string'
      ? args['openclaw-version']
      : 'stable'

    // ── Local provider path (no Pulumi) ────────────────────────────────────────
    if (ctx.adapter.name === 'local') {
      const stackConfig = ctx.config.stacks[ctx.stackName]
      if (!stackConfig?.localOpts) {
        throw new UsageError(
          `Stack "${ctx.stackName}" has no localOpts. ` +
            'Run `clawops init --provider local --host <HOST>` first.',
        )
      }

      const { localOpts } = stackConfig
      const { localBootstrap } = await import('../../providers/local/bootstrap.js')

      const abortController = new AbortController()
      process.on('SIGINT', () => abortController.abort())
      process.on('SIGTERM', () => abortController.abort())

      const spin = spinner(`Bootstrapping local host "${localOpts.host}"...`)
      try {
        const state = await localBootstrap({
          host: localOpts.host,
          port: localOpts.sshPort,
          user: localOpts.sshUser,
          privateKeyPath: localOpts.sshKeyPath,
          knownHostsPath: ctx.config.ssh.knownHostsPath,
          openclawVersion,
          stackName: ctx.stackName,
          noWait: Boolean(args['no-wait']),
          signal: abortController.signal,
        })
        spin.succeed(`Host "${localOpts.host}" bootstrapped`)
        info(`Gateway URL: ${state.gatewayUrl}`)
        info(`SSH:         ${state.sshUser}@${state.sshHost}:${state.sshPort}`)

        // Apply config overlay if --config was supplied.
        if (typeof args.config === 'string') {
          await applyLocalConfigOverlay({
            configPath: args.config,
            host: localOpts.host,
            port: localOpts.sshPort,
            user: localOpts.sshUser,
            privateKeyPath: localOpts.sshKeyPath,
            knownHostsPath: ctx.config.ssh.knownHostsPath,
            signal: abortController.signal,
          })
          info('Config overlay applied and gateway restarted.')
        }
      } catch (err) {
        spin.fail('Bootstrap failed')
        throw err
      }
      return
    }

    // ── Cloud provider path (Pulumi) ───────────────────────────────────────────
    const instanceAlias = typeof args['instance-type'] === 'string' ? args['instance-type'] : 'small'
    if (!VALID_INSTANCE_TYPES.includes(instanceAlias as typeof VALID_INSTANCE_TYPES[number])) {
      throw new UsageError(
        `Invalid --instance-type: ${instanceAlias}. Valid values: ${VALID_INSTANCE_TYPES.join(', ')}`,
      )
    }

    const isDryRun = Boolean(args['dry-run'])

    const validation = await ctx.adapter.validateConfig()
    if (!validation.ok) {
      for (const e of validation.errors) failure(e)
      process.exit(3)
    }

    const stack = await ctx.getStack()

    const region = typeof args.region === 'string' ? args.region : ctx.adapter.defaultRegion()
    const instanceType = ctx.adapter.normalizeInstanceType(
      instanceAlias as typeof VALID_INSTANCE_TYPES[number],
    )

    await stack.setConfig('region', { value: region })
    await stack.setConfig('instanceType', { value: instanceType })
    await stack.setConfig('openclawVersion', { value: openclawVersion })

    if (isDryRun) {
      info('Previewing changes (--dry-run)...')
      const preview = await stack.preview({ onOutput: (out) => process.stdout.write(out) })
      process.stdout.write('\n')
      if (preview.changeSummary) {
        const rows = Object.entries(preview.changeSummary)
          .filter(([, count]) => count > 0)
          .map(([op, count]) => [op, String(count)])
        if (rows.length > 0) {
          process.stdout.write(renderTable(['Operation', 'Count'], rows) + '\n')
        }
      }
      success('Preview complete (no resources changed)')
      return
    }

    const spin = spinner(`Deploying stack "${ctx.stackName}"...`)
    try {
      const result = await stack.up({
        onOutput: (out) => {
          spin.text = out.trim() || spin.text
        },
      })
      spin.succeed(`Stack "${ctx.stackName}" deployed`)

      const outputs = result.outputs
      if (outputs['publicIp']) {
        info(`Public IP:   ${outputs['publicIp'].value}`)
      }
      if (outputs['gatewayUrl']) {
        info(`Gateway URL: ${outputs['gatewayUrl'].value}`)
      }
    } catch (err) {
      spin.fail('Deployment failed')
      throw err
    }
  },
})

interface LocalOverlayOpts {
  configPath: string
  host: string
  port: number
  user: string
  privateKeyPath: string
  knownHostsPath: string
  signal?: AbortSignal
}

async function applyLocalConfigOverlay(opts: LocalOverlayOpts): Promise<void> {
  const { connect } = await import('../../transport/ssh.js')
  const { resolveSecrets } = await import('../../plan/secrets.js')
  const { readRemoteConfig, atomicWriteConfig, restartGateway, deepMerge } = await import('../../plan/remote-config.js')

  let overlay: Record<string, unknown>
  try {
    overlay = JSON.parse(readFileSync(opts.configPath, 'utf-8')) as Record<string, unknown>
  } catch (err) {
    throw new UsageError(`Cannot read config overlay at ${opts.configPath}: ${(err as Error).message}`)
  }

  // Resolve any $secret: references using environment variables only (local path).
  const resolved = resolveSecrets(overlay, []) as Record<string, unknown>

  const session = await connect({
    host: opts.host,
    port: opts.port,
    user: opts.user,
    privateKeyPath: opts.privateKeyPath,
    knownHostsPath: opts.knownHostsPath,
    signal: opts.signal,
  })
  try {
    const remote = await readRemoteConfig(session, opts.signal)
    const merged = deepMerge(remote, resolved)
    await atomicWriteConfig(session, merged, opts.signal)
    await restartGateway(session, opts.signal)
  } finally {
    session.close()
  }
}
