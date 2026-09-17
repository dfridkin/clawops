import { defineCommand } from 'citty'
import { GATEWAY_PORT } from '../../openclaw/run-flags.js'
import process from 'node:process'
import { readFileSync } from 'node:fs'
import { success, failure, info, spinner } from '../../output/human.js'
import { renderTable } from '../../output/table.js'
import { UsageError } from '../../errors/index.js'

export default defineCommand({
  meta: {
    name: 'up',
    description: 'Provision and deploy an OpenClaw stack',
  },
  args: {
    provider: { type: 'string', description: 'Cloud provider (gcp|aws|azure|local)' },
    region: { type: 'string', description: 'Cloud region' },
    'instance-type': { type: 'string', description: 'Instance size: a clawops alias (micro|small|medium|large|gpu) or a type your cloud names itself, e.g. t3.small' },
    'dry-run': { type: 'boolean', description: 'Preview without applying' },
    'no-wait': { type: 'boolean', description: 'Return immediately without waiting for healthy state' },
    'openclaw-version': { type: 'string', description: "OpenClaw release (e.g. 2026.7.1-2). Moving tags are resolved and range-checked" },
    stack: { type: 'string', description: 'Target stack name' },
    config: { type: 'string', description: 'Path to openclaw config overlay JSON (local provider only)' },
    'gateway-port': { type: 'string', description: `Host port to publish the gateway on (default ${GATEWAY_PORT})` },
    'ssh-cidr': { type: 'string', description: "CIDR(s) allowed to reach SSH, comma-separated, or 'auto' for this machine's IP. Omitted = none, and nothing will be able to connect" },
    'gateway-cidr': { type: 'string', description: "CIDR(s) allowed to reach the gateway port, or 'auto'. Requires --publish-gateway all" },
    'publish-gateway': { type: 'string', description: 'loopback (default) or all. "all" serves plaintext HTTP — put TLS in front of it' },
  },
  async run({ args }) {
    const { buildContext } = await import('../context.js')

    const { guardOpenclawVersion, defaultOpenclawVersion } = await import('../version-guard.js')

    const ctx = buildContext(args)
    const requestedVersion = typeof args['openclaw-version'] === 'string'
      ? args['openclaw-version']
      : await defaultOpenclawVersion()
    // Refuse an unsupported OpenClaw release before provisioning anything.
    const openclawVersion = await guardOpenclawVersion(requestedVersion)

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
      const gatewayPort = parseGatewayPort(args['gateway-port'])

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
          gatewayPort,
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

    // ── Cloud provider path ────────────────────────────────────────────────────
    //
    // One deploy path, shared with `clawops apply`. This used to be a second implementation
    // that set three pieces of stack config — region, instanceType, openclawVersion — and none
    // of the rest, so the Pulumi programs refused to run:
    //
    //   Stack config "sshPublicKey" is required for the GCP adapter
    //
    // It also opened no firewall rules, pinned no GCP project and waited for nothing, which are
    // the same defects `plan`/`apply` carried until this release. Two implementations of one
    // operation drift, and the quiet one drifts unnoticed: the wizard builds a plan and applies
    // it, so nothing exercised this path.
    const { generatePlan } = await import('../../plan/generate.js')
    const { applyPlan } = await import('../../plan/apply.js')
    const { resolveNetworkFlags } = await import('../../plan/network-args.js')
    const { detectEgressIp } = await import('../../providers/firewall.js')

    const isDryRun = Boolean(args['dry-run'])

    const validation = await ctx.adapter.validateConfig()
    if (!validation.ok) {
      for (const e of validation.errors) failure(e)
      process.exit(3)
    }

    if (typeof args.config === 'string') {
      info('--config applies to local stacks only; put the overlay in the plan for a cloud stack.')
    }

    const abortController = new AbortController()
    process.on('SIGINT', () => abortController.abort())
    process.on('SIGTERM', () => abortController.abort())

    const network = await resolveNetworkFlags(
      {
        sshCidr: strArg(args['ssh-cidr']),
        gatewayCidr: strArg(args['gateway-cidr']),
        publishGateway: strArg(args['publish-gateway']),
      },
      { detectEgressIp: () => detectEgressIp('https://ifconfig.me/ip') },
    )
    const cloudGatewayPort = strArg(args['gateway-port'])
    if (cloudGatewayPort) network.gatewayPort = parseGatewayPort(cloudGatewayPort)

    const spin = spinner(`Deploying stack "${ctx.stackName}"...`)
    try {
      const plan = await generatePlan(
        {
          stackName: ctx.stackName,
          provider: ctx.adapter.name as 'aws' | 'gcp' | 'azure',
          ...(strArg(args.region) ? { region: strArg(args.region) as string } : {}),
          ...(strArg(args['instance-type'])
            ? { instanceType: strArg(args['instance-type']) as string }
            : {}),
          openclawVersion,
          network,
        },
        { signal: abortController.signal },
      )

      if (isDryRun) {
        spin.stop()
        info('Previewing changes (--dry-run)...')
        const diff = plan.diff
        if (diff && diff.totalChanges > 0) {
          const rows = [
            ['create', String(diff.create.length)],
            ['update', String(diff.update.length)],
            ['delete', String(diff.delete.length)],
          ].filter(([, count]) => count !== '0')
          process.stdout.write(renderTable(['Operation', 'Count'], rows) + '\n')
        }
        success('Preview complete (no resources changed)')
        return
      }

      const result = await applyPlan(plan, {
        onOutput: (line) => { spin.text = line.trim() || spin.text },
        onProgress: (line) => {
          const text = line.trim()
          if (!text) return
          spin.text = text
          if (!process.stderr.isTTY) process.stderr.write(`${text}\n`)
        },
        signal: abortController.signal,
        skipReadiness: Boolean(args['no-wait']),
      })
      spin.succeed(`Stack "${ctx.stackName}" deployed`)

      if (result.outputs['publicIp']) info(`Public IP:   ${String(result.outputs['publicIp'])}`)
      if (result.outputs['gatewayUrl']) info(`Gateway URL: ${String(result.outputs['gatewayUrl'])}`)
    } catch (err) {
      spin.fail('Deployment failed')
      throw err
    }
  },
})

/** citty hands through unparsed values; only a real string is an answer. */
function strArg(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

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

/**
 * The gateway port for a local bootstrap.
 *
 * Rejected rather than silently defaulted: a typo'd port would otherwise publish the
 * gateway somewhere the operator did not ask for and report success.
 */
function parseGatewayPort(raw: unknown): number | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new UsageError(`--gateway-port must be a port number between 1 and 65535, got "${raw}"`)
  }
  return port
}
