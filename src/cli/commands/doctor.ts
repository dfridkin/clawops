import { defineCommand } from 'citty'
import process from 'node:process'
import { accessSync, mkdirSync, constants } from 'node:fs'
import path from 'node:path'
import { success, failure, warn, info, REPO_URL } from '../../output/human.js'

export default defineCommand({
  meta: {
    name: 'doctor',
    description: 'Check system prerequisites, config, SSH keys, and cloud credentials',
  },
  args: {
    stack: { type: 'string', description: 'Stack name to include remote health checks' },
  },
  async run({ args }) {
    const { getConfig, getConfigDir } = await import('../../config/store.js')

    process.stdout.write('\nclawops doctor\n')

    // ── Runtime ─────────────────────────────────────────────────────────────
    process.stdout.write('\nRuntime\n')

    const nodeVersion = process.version
    const nodeMajor = parseInt(nodeVersion.slice(1).split('.')[0] ?? '0', 10)
    const nodeOk = nodeMajor >= 22
    if (nodeOk) {
      success(`Node.js ${nodeVersion}`)
    } else {
      failure(`Node.js ${nodeVersion}  (requires >=22)`)
    }

    // Pulumi home (embedded — just ensure the directory can be created)
    const configDir = getConfigDir()
    const pulumiHome = path.join(configDir, '.pulumi')
    try {
      mkdirSync(pulumiHome, { recursive: true })
      success(`Pulumi home  ${pulumiHome}`)
    } catch {
      failure(`Pulumi home  ${pulumiHome}  (not writable)`)
    }

    // ── Config ───────────────────────────────────────────────────────────────
    process.stdout.write('\nConfig\n')

    const config = getConfig()
    if (!config) {
      warn('No config file found — run `clawops init` to create one')
    } else {
      success(`Config file  ${path.join(configDir, 'config.json')}`)
    }

    // ── SSH ──────────────────────────────────────────────────────────────────
    process.stdout.write('\nSSH\n')

    if (!config) {
      info('SSH checks skipped — no config')
    } else {
      const keyPath = config.ssh.keyPath.replace(/^~/, process.env['HOME'] ?? '~')
      try {
        accessSync(keyPath, constants.R_OK)
        success(`SSH key      ${keyPath}`)
      } catch {
        failure(`SSH key      ${keyPath}  (not found or not readable)`)
      }

      const knownHostsPath = config.ssh.knownHostsPath.replace(/^~/, process.env['HOME'] ?? '~')
      try {
        accessSync(knownHostsPath, constants.F_OK)
        success(`known_hosts  ${knownHostsPath}`)
      } catch {
        warn(`known_hosts  ${knownHostsPath}  (does not exist — will be created on first connect)`)
      }
    }

    // ── Credentials ──────────────────────────────────────────────────────────
    process.stdout.write('\nCredentials\n')

    if (!config) {
      info('Credential checks skipped — no config')
    } else {
      const { getProvider } = await import('../../providers/index.js')

      // Register all adapters (side-effect imports)
      await import('../../providers/aws/index.js')
      await import('../../providers/gcp/index.js')
      await import('../../providers/azure/index.js')
      await import('../../providers/local/index.js')

      const checkedProviders = new Set<string>()
      for (const [stackName, stackCfg] of Object.entries(config.stacks)) {
        const providerName = stackCfg.provider
        if (checkedProviders.has(providerName)) continue
        checkedProviders.add(providerName)

        if (providerName === 'local') {
          success(`local  stack "${stackName}"  (SSH-only, no cloud credentials required)`)
          continue
        }

        try {
          const adapter = getProvider(providerName as 'aws' | 'gcp' | 'azure')
          const result = await adapter.validateConfig()
          if (result.ok) {
            success(`${providerName}  stack "${stackName}"`)
          } else {
            for (const err of result.errors) {
              failure(`${providerName}  stack "${stackName}"  — ${err}`)
            }
          }
        } catch (err) {
          failure(`${providerName}  stack "${stackName}"  — ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      if (checkedProviders.size === 0) {
        warn('No stacks configured — run `clawops init`')
      }
    }

    // ── Remote health (requires --stack) ─────────────────────────────────────
    if (args.stack) {
      process.stdout.write('\nRemote health\n')

      if (!config) {
        info('Remote health skipped — no config')
      } else {
        try {
          const { buildContext } = await import('../context.js')
          const { extractBaseOutputs } = await import('../../pulumi/outputs.js')
          const { acquireSession, drainPool } = await import('../../transport/pool.js')

          const ctx = buildContext({ stack: args.stack })
          const stack = await ctx.getStack()
          const outputMap = await stack.outputs()
          const outputs: Record<string, unknown> = Object.fromEntries(
            Object.entries(outputMap).map(([k, v]) => [k, v.value]),
          )
          const base = extractBaseOutputs(outputs)
          const conn = ctx.adapter.getConnectionInfo({
            ...base,
            privateKeyPath: config.ssh.keyPath,
            knownHostsPath: config.ssh.knownHostsPath,
          })

          const ac = new AbortController()
          process.on('SIGINT', () => ac.abort())
          process.on('SIGTERM', () => ac.abort())

          const { session, release } = await acquireSession({
            host: conn.host,
            port: conn.port,
            user: conn.user,
            privateKeyPath: conn.privateKeyPath,
            knownHostsPath: conn.knownHostsPath,
            signal: ac.signal,
          })

          try {
            // Container status
            const containerResult = await session.exec(
              `docker inspect openclaw --format '{{.State.Status}}' 2>/dev/null || echo 'not found'`,
              ac.signal,
            )
            const containerStatus = containerResult.stdout.trim()
            if (containerStatus === 'running') {
              success(`Container    running`)
            } else {
              failure(`Container    ${containerStatus || 'unknown'}`)
            }

            // Docker healthcheck
            const healthResult = await session.exec(
              `docker inspect openclaw --format '{{.State.Health.Status}}' 2>/dev/null || echo 'none'`,
              ac.signal,
            )
            const healthStatus = healthResult.stdout.trim()
            if (healthStatus === 'healthy') {
              success(`Healthcheck  healthy`)
            } else if (healthStatus === 'none' || healthStatus === '<no value>') {
              info(`Healthcheck  no healthcheck configured`)
            } else {
              warn(`Healthcheck  ${healthStatus}`)
            }

            // Disk usage
            const diskResult = await session.exec(
              `df -h /home/clawops 2>/dev/null | awk 'NR==2{print $5" used ("$3" of "$2")"}'`,
              ac.signal,
            )
            const diskUsage = diskResult.stdout.trim()
            if (diskUsage) {
              const pctMatch = diskUsage.match(/^(\d+)%/)
              const pct = pctMatch ? parseInt(pctMatch[1]!, 10) : 0
              if (pct >= 90) {
                failure(`Disk         ${diskUsage}`)
              } else if (pct >= 75) {
                warn(`Disk         ${diskUsage}`)
              } else {
                success(`Disk         ${diskUsage}`)
              }
            } else {
              warn('Disk         unable to determine disk usage')
            }

            // Log rotation
            const logrotateResult = await session.exec(
              `test -f /etc/logrotate.d/openclaw && echo 'configured' || echo 'not configured'`,
              ac.signal,
            )
            const logrotate = logrotateResult.stdout.trim()
            if (logrotate === 'configured') {
              success(`Log rotation configured`)
            } else {
              warn(`Log rotation not configured — logs may grow unbounded`)
            }
          } finally {
            release()
            drainPool()
          }
        } catch (err) {
          failure(`Remote health checks failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }

    // ── Hardening status (requires --stack) ──────────────────────────────────
    if (args.stack && config) {
      process.stdout.write('\nHardening\n')
      try {
        const { MODULE_CATALOG, resolveModules, withRemoteExec } = await import('../../harden/index.js')
        const { buildContext } = await import('../context.js')
        const { extractBaseOutputs } = await import('../../pulumi/outputs.js')

        const ctx = buildContext({ stack: args.stack })
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

        const hardenAc = new AbortController()
        process.on('SIGINT', () => hardenAc.abort())

        const provider = ctx.adapter.name
        const modules = resolveModules(MODULE_CATALOG, undefined, provider)

        await withRemoteExec(conn, hardenAc.signal, async (exec) => {
          for (const mod of modules) {
            const result = await mod.check(exec)
            if (result.status === 'applied') {
              success(`${mod.label.padEnd(32)} applied`)
            } else if (result.status === 'drifted') {
              warn(`${mod.label.padEnd(32)} drifted — ${result.detail}`)
            } else if (result.status === 'missing') {
              info(`${mod.label.padEnd(32)} not applied — run \`clawops harden\``)
            }
            // 'skipped' modules are silently omitted
          }
        })
      } catch (err) {
        failure(`Hardening checks failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    process.stdout.write('\n')

    if (!nodeOk) {
      process.stdout.write(
        `Run \`clawops bug\` to open a pre-filled issue at ${REPO_URL}/issues\n\n`,
      )
      process.exit(1)
    }
  },
})
