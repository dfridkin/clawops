import { defineCommand } from 'citty'
import process from 'node:process'
import { accessSync, mkdirSync, constants } from 'node:fs'
import path from 'node:path'
import { success, failure, warn, info } from '../../output/human.js'

export default defineCommand({
  meta: {
    name: 'doctor',
    description: 'Check system prerequisites, config, SSH keys, and cloud credentials',
  },
  async run() {
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

    process.stdout.write('\n')
    if (!nodeOk) process.exit(1)
  },
})
