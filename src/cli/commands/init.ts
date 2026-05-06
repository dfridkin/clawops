import { defineCommand } from 'citty'
import { generateKeyPairSync } from 'node:crypto'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { success, failure, info } from '../../output/human.js'
import { setConfig, getConfigDir, getConfig } from '../../config/store.js'
import type { ClawopsConfig } from '../../config/store.js'
import { UsageError } from '../../errors/index.js'

const SUPPORTED_PROVIDERS = ['gcp'] as const
type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number]

const PROVIDER_DEFAULTS: Record<SupportedProvider, { region: string; credEnv: string }> = {
  gcp: { region: 'us-central1', credEnv: 'GOOGLE_APPLICATION_CREDENTIALS' },
}

export default defineCommand({
  meta: {
    name: 'init',
    description: 'Initialise clawops: choose provider, configure state backend, generate SSH key',
  },
  args: {
    provider: { type: 'string', description: 'Cloud provider (gcp|aws|azure|local)' },
    state: { type: 'string', description: 'State backend URL (e.g. gs://my-bucket/clawops)' },
    region: { type: 'string', description: 'Cloud region (defaults per provider)' },
    stack: { type: 'string', description: 'Stack name (default: "default")' },
    'non-interactive': { type: 'boolean', description: 'Suppress all prompts; requires --provider' },
    force: { type: 'boolean', description: 'Overwrite existing config without prompting' },
  },
  async run({ args }) {
    const nonInteractive = Boolean(args['non-interactive'])
    const providerArg = typeof args.provider === 'string' ? args.provider : null
    const stackName = typeof args.stack === 'string' ? args.stack : 'default'
    const forceOverwrite = Boolean(args.force)

    if (nonInteractive && !providerArg) {
      throw new UsageError(
        '--non-interactive requires --provider. ' +
          'Example: clawops init --provider gcp --non-interactive',
      )
    }

    const provider: SupportedProvider = (providerArg as SupportedProvider) ?? 'gcp'
    if (!SUPPORTED_PROVIDERS.includes(provider)) {
      throw new UsageError(
        `Unsupported provider: ${provider}. Supported: ${SUPPORTED_PROVIDERS.join(', ')}`,
      )
    }

    const existing = getConfig()
    if (existing && !forceOverwrite && !nonInteractive) {
      failure(
        `Config already exists at ${path.join(getConfigDir(), 'config.json')}. ` +
          'Use --force to overwrite.',
      )
      process.exit(1)
    }

    const defaults = PROVIDER_DEFAULTS[provider]
    const region = typeof args.region === 'string' ? args.region : defaults.region
    const stateUrl =
      typeof args.state === 'string'
        ? args.state
        : `gs://CHANGEME/clawops` // placeholder — update before `clawops up`

    const configDir = getConfigDir()
    mkdirSync(configDir, { recursive: true })

    // Generate SSH key pair if not already present
    const keyPath = path.join(configDir, 'id_ed25519')
    const knownHostsPath = path.join(configDir, 'known_hosts')

    if (!existsSync(keyPath)) {
      info('Generating SSH key pair...')
      const { privateKey } = generateKeyPairSync('ed25519', {
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      })
      writeFileSync(keyPath, privateKey, { mode: 0o600 })
      success(`SSH private key written to ${keyPath}`)
    } else {
      info(`Using existing SSH key at ${keyPath}`)
    }

    if (!existsSync(knownHostsPath)) {
      writeFileSync(knownHostsPath, '', 'utf-8')
    }

    const config: ClawopsConfig = {
      version: 1,
      defaults: { stack: stackName, provider },
      stacks: {
        [stackName]: {
          provider,
          stateUrl,
          region,
          credentialsRef: { source: 'env', envVars: [defaults.credEnv] },
        },
      },
      ssh: { keyPath, knownHostsPath },
    }

    setConfig(config)
    success(`Config written to ${path.join(configDir, 'config.json')}`)

    if (stateUrl.includes('CHANGEME')) {
      process.stdout.write('\n')
      info(
        'Update stateUrl in the config to a real GCS bucket before running `clawops up`.\n' +
          `  Example: clawops init --provider ${provider} --state gs://your-bucket/clawops`,
      )
    }

    process.stdout.write('\n')
    success(`Provider: ${provider}  Region: ${region}  Stack: ${stackName}`)
  },
})
