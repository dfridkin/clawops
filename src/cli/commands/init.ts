import { defineCommand } from 'citty'
import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { success, failure, info } from '../../output/human.js'
import { setConfig, getConfigDir, getConfig } from '../../config/store.js'
import type { ClawopsConfig } from '../../config/store.js'
import { UsageError } from '../../errors/index.js'

const SUPPORTED_PROVIDERS = ['gcp', 'aws', 'azure', 'local'] as const
type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number]

const PROVIDER_DEFAULTS: Record<
  Exclude<SupportedProvider, 'local'>,
  { region: string; credEnv: string; stateScheme: string }
> = {
  gcp:   { region: 'us-central1', credEnv: 'GOOGLE_APPLICATION_CREDENTIALS', stateScheme: 'gs://' },
  aws:   { region: 'us-east-1',   credEnv: 'AWS_PROFILE',                    stateScheme: 's3://' },
  azure: { region: 'eastus',      credEnv: 'AZURE_CLIENT_ID',                stateScheme: 'azblob://' },
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
    // local-specific
    host: { type: 'string', description: '[local] Hostname or IP of the target machine' },
    'ssh-user': { type: 'string', description: '[local] SSH login user (default: root)' },
    'ssh-port': { type: 'string', description: '[local] SSH port (default: 22)' },
    'key-path': { type: 'string', description: '[local] Path to an existing SSH private key' },
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

    const configDir = getConfigDir()
    mkdirSync(configDir, { recursive: true })

    // Generate (or reuse) SSH key pair
    const keyPath = typeof args['key-path'] === 'string'
      ? args['key-path']
      : path.join(configDir, 'id_ed25519')
    const knownHostsPath = path.join(configDir, 'known_hosts')

    if (!existsSync(keyPath)) {
      if (typeof args['key-path'] === 'string') {
        throw new UsageError(`SSH key not found at ${keyPath}`)
      }
      info('Generating SSH key pair...')
      // ssh-keygen, not crypto.generateKeyPairSync. The latter writes a PKCS#8 PEM: a valid
      // ed25519 key that ssh2 — which every clawops SSH operation uses — cannot parse, and
      // that OpenSSH itself rejects with "invalid format". `clawops init` produced one of
      // those, so the key it generated could not be used by the tool that generated it, and
      // nothing noticed until `doctor` started parsing the key instead of stat-ing it.
      const gen = spawnSync(
        'ssh-keygen',
        ['-t', 'ed25519', '-f', keyPath, '-N', '', '-C', 'clawops', '-q'],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )
      if (gen.error || gen.status !== 0) {
        const reason = gen.error?.message ?? gen.stderr?.toString().trim() ?? `exit ${gen.status}`
        throw new UsageError(
          `Could not generate an SSH key: ${reason}\n` +
            `Generate one yourself and point clawops at it:\n` +
            `  ssh-keygen -t ed25519 -f ${keyPath} -N '' -C clawops\n` +
            `  clawops init --key-path ${keyPath}`,
        )
      }
      success(`SSH key pair written to ${keyPath} (and ${keyPath}.pub)`)
    } else {
      info(`Using existing SSH key at ${keyPath}`)
    }

    if (!existsSync(knownHostsPath)) {
      writeFileSync(knownHostsPath, '', 'utf-8')
    }

    let config: ClawopsConfig

    if (provider === 'local') {
      const host = typeof args.host === 'string' ? args.host : ''
      if (!host) {
        throw new UsageError('--host is required for the local provider')
      }
      const sshUser = typeof args['ssh-user'] === 'string' ? args['ssh-user'] : 'root'
      const sshPort = typeof args['ssh-port'] === 'string' ? parseInt(args['ssh-port'], 10) : 22

      config = {
        version: 1,
        defaults: { stack: stackName, provider },
        stacks: {
          [stackName]: {
            provider,
            stateUrl: 'file://~/.clawops/state',
            credentialsRef: { source: 'file', envVars: [] },
            localOpts: { host, sshUser, sshPort, sshKeyPath: keyPath },
          },
        },
        ssh: { keyPath, knownHostsPath },
      }
    } else {
      const defaults = PROVIDER_DEFAULTS[provider]
      const region = typeof args.region === 'string' ? args.region : defaults.region
      const stateUrl =
        typeof args.state === 'string'
          ? args.state
          : `${defaults.stateScheme}CHANGEME/clawops`

      config = {
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

      if (stateUrl.includes('CHANGEME')) {
        process.stdout.write('\n')
        info(
          `Update stateUrl in the config to a real state backend before running \`clawops up\`.\n` +
            `  Example: clawops init --provider ${provider} --state ${defaults.stateScheme}your-bucket/clawops`,
        )
      }

      process.stdout.write('\n')
      success(`Provider: ${provider}  Region: ${region}  Stack: ${stackName}`)
      setConfig(config)
      success(`Config written to ${path.join(configDir, 'config.json')}`)
      return
    }

    setConfig(config)
    success(`Config written to ${path.join(configDir, 'config.json')}`)
    process.stdout.write('\n')
    success(`Provider: ${provider}  Stack: ${stackName}`)
  },
})
