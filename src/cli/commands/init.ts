import { defineCommand } from 'citty'
import path from 'node:path'
import process from 'node:process'
import { success, failure, info } from '../../output/human.js'
import { getConfigDir } from '../../config/store.js'
import { UsageError } from '../../errors/index.js'
import { initStack, SUPPORTED_PROVIDERS, type SupportedProvider } from '../../config/init.js'

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

    if (nonInteractive && !providerArg) {
      throw new UsageError(
        '--non-interactive requires --provider. ' +
          'Example: clawops init --provider gcp --non-interactive',
      )
    }

    const provider = (providerArg as SupportedProvider) ?? 'gcp'
    if (!SUPPORTED_PROVIDERS.includes(provider)) {
      throw new UsageError(
        `Unsupported provider: ${provider}. Supported: ${SUPPORTED_PROVIDERS.join(', ')}`,
      )
    }

    const result = await initStack({
      provider,
      stackName: typeof args.stack === 'string' ? args.stack : undefined,
      stateUrl: typeof args.state === 'string' ? args.state : undefined,
      region: typeof args.region === 'string' ? args.region : undefined,
      force: Boolean(args.force),
      keyPath: typeof args['key-path'] === 'string' ? args['key-path'] : undefined,
      host: typeof args.host === 'string' ? args.host : undefined,
      sshUser: typeof args['ssh-user'] === 'string' ? args['ssh-user'] : undefined,
      sshPort: typeof args['ssh-port'] === 'string' ? parseInt(args['ssh-port'], 10) : undefined,
    })

    if (!result.ok) {
      // An existing stack is the operator's mistake to correct, not a crash; the rest are
      // conditions they need the detail of.
      if (result.reason.includes('already exists')) {
        failure(result.reason.replace('Pass force', 'Use --force'))
        process.exit(1)
      }
      throw new UsageError(result.reason)
    }

    if (result.keyGenerated) success(`SSH key pair written to ${result.keyPath} (and ${result.keyPath}.pub)`)
    else info(`Using existing SSH key at ${result.keyPath}`)

    if (result.provider !== 'local') {
      process.stdout.write('\n')
      info(
        `State backend: ${result.stateUrl}\n` +
          `  clawops doctor --provider ${result.provider} checks it exists, and clawops setup ` +
          `offers to create it.`,
      )
      process.stdout.write('\n')
      success(`Provider: ${result.provider}  Region: ${result.region}  Stack: ${result.stackName}`)
      success(`Config written to ${path.join(getConfigDir(), 'config.json')}`)
      return
    }

    success(`Config written to ${result.configPath}`)
    process.stdout.write('\n')
    success(`Provider: ${result.provider}  Stack: ${result.stackName}`)
  }
})
