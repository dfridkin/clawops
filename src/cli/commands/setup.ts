// clawops setup — interactive wizard for first-run configuration.
// Produces a deploy plan (cloud) or openclaw config overlay (local) and
// optionally applies it. Reads spec/models.yaml and spec/integrations.yaml
// at runtime; no codegen needed for those catalog files.

import { defineCommand } from 'citty'
import process from 'node:process'
import os from 'node:os'
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { execSync, spawnSync, spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { success, failure, info, spinner, printCta } from '../../output/human.js'
import type { ClawopsConfig } from '../../config/store.js'
import { MCP_APPS, buildMcpEntry, writeAppConfigs } from '../mcp-apps.js'

// Minimal typing shim for inquirer v9 (ships no bundled .d.ts).
interface InquirerQuestion {
  type: 'input' | 'number' | 'confirm' | 'list' | 'password' | 'checkbox'
  name: string
  message: string
  choices?: Array<{ name: string; value: unknown; checked?: boolean }> | Array<string>
  default?: unknown
  validate?: (v: string) => boolean | string | Promise<boolean | string>
  pageSize?: number
}
interface InquirerInstance {
  prompt<T>(questions: InquirerQuestion[]): Promise<T>
}

// Catalog types — mirrors spec/models.yaml and spec/integrations.yaml shape.
interface ModelEntry {
  id: string
  displayName: string
  modelId?: string
  family?: string
  recommended?: boolean
  pullSuffix?: string
}

interface ModelProvider {
  id: string
  displayName: string
  credentialSource: 'api-key' | 'aws-profile' | 'none'
  envDefault?: string
  iamNote?: string
  iamPolicy?: string
  models: ModelEntry[]
  defaultModel: string
  configPath: string
  baseUrlDefault?: string
  postSetupNote?: string
}

interface IntegrationField {
  name: string
  label: string
  description: string
  sensitive: boolean
  envDefault: string
}

interface Integration {
  id: string
  channelKey: string
  displayName: string
  description: string
  infraRequired: boolean
  infraNote?: string
  fields: IntegrationField[]
  setupUrl?: string
}

interface Catalogs {
  models: ModelProvider[]
  integrations: Integration[]
}

export default defineCommand({
  meta: {
    name: 'setup',
    description: 'Interactive wizard: configure and deploy an OpenClaw stack',
  },
  args: {
    'dry-run': { type: 'boolean', description: 'Generate plan/config without applying' },
    'output-dir': { type: 'string', description: 'Directory to write generated files (skips prompt)' },
  },
  async run({ args }) {
    const inquirer = (await import('inquirer')).default as unknown as InquirerInstance
    const yaml = await import('js-yaml')

    const catalogs = loadCatalogs(yaml)
    const dryRun = Boolean(args['dry-run'])

    const ac = new AbortController()
    process.on('SIGINT', () => { ac.abort(); process.exit(130) })
    process.on('SIGTERM', () => { ac.abort(); process.exit(143) })

    process.stdout.write('\nWelcome to clawops setup. This wizard will help you deploy OpenClaw\n')
    process.stdout.write('and connect it to your AI tools. It takes about 2 minutes.\n\n')

    // ── Step 1: Deployment type ────────────────────────────────────────────────
    const { deploymentType } = await inquirer.prompt<{ deploymentType: 'cloud' | 'local' }>([{
      type: 'list',
      name: 'deploymentType',
      message: 'Where would you like to run OpenClaw?',
      choices: [
        { name: 'Cloud (AWS, GCP, or Azure) — deploy to paid cloud hosting', value: 'cloud' },
        { name: 'Deploy to a local or existing server — connect over SSH (Linux or macOS)', value: 'local' },
      ],
    }])

    // ── Step 2: Provider / connection details ──────────────────────────────────
    let provider: 'aws' | 'gcp' | 'azure' | 'local'
    let localHost = ''
    let localUser = os.userInfo().username
    let localKeyPath = detectSshKey()
    let localPort = 22
    let localSudoPassword = ''

    if (deploymentType === 'cloud') {
      const answer = await inquirer.prompt<{ provider: 'aws' | 'gcp' | 'azure' }>([{
        type: 'list',
        name: 'provider',
        message: 'Which cloud service would you like to use?',
        choices: [
          { name: 'Amazon Web Services (AWS)  — most popular, widest region coverage', value: 'aws' },
          { name: 'Google Cloud (GCP)         — good pricing, strong in AI workloads', value: 'gcp' },
          { name: 'Microsoft Azure            — best if your team already uses Microsoft', value: 'azure' },
        ],
      }])
      provider = answer.provider
      process.stdout.write('\n')
      await ensureCloudAuth(provider, inquirer)
    } else {
      provider = 'local'
      info('We\'ll connect to your server over SSH to install and configure OpenClaw.\n')

      // Offer to generate a key if no key is detected
      if (!existsSync(localKeyPath)) {
        info(`No SSH key found at ${localKeyPath}.`)
        const { genKey } = await inquirer.prompt<{ genKey: boolean }>([{
          type: 'confirm',
          name: 'genKey',
          message: 'Generate a new SSH key pair now? (recommended if you don\'t have one)',
          default: true,
        }])
        if (genKey) {
          localKeyPath = await generateSshKey()
        }
      }

      const localAnswers = await inquirer.prompt<{
        host: string; port: number; user: string; keyPath: string
      }>([
        {
          type: 'input',
          name: 'host',
          message: 'Server address: (IP address or hostname, e.g. 192.168.1.100 or myserver.example.com)',
          validate: (v: string) => v.trim() !== '' || 'Please enter a server address',
        },
        {
          type: 'number',
          name: 'port',
          message: 'SSH port: (almost always 22 — press Enter to accept)',
          default: 22,
        },
        {
          type: 'input',
          name: 'user',
          message: 'SSH username: (e.g. "ubuntu" on AWS, "ec2-user" on Amazon Linux, or your local username for localhost)',
          default: localUser,
        },
        {
          type: 'input',
          name: 'keyPath',
          message: `SSH private key file: (the key file on your computer used to log in — e.g. ~/.ssh/id_ed25519)`,
          default: localKeyPath,
          validate: (v: string) => existsSync(v.trim()) || `File not found: ${v.trim()}`,
        },
      ])
      localHost = localAnswers.host
      localPort = localAnswers.port
      localUser = localAnswers.user
      localKeyPath = localAnswers.keyPath

      await ensureAuthorizedKey(localKeyPath, localHost, inquirer)

      const { sudoPass } = await inquirer.prompt<{ sudoPass: string }>([{
        type: 'password',
        name: 'sudoPass',
        message: `Sudo password for ${localUser}@${localHost}: (press Enter to skip if passwordless sudo is configured)`,
      }])
      localSudoPassword = sudoPass
    }

    // ── Step 3: Stack basics ───────────────────────────────────────────────────
    process.stdout.write('\n')
    const stackAnswers = await inquirer.prompt<{
      stackName: string; region: string; instanceSize: string;
      stateBucket: string; sshKeyPath: string; sshCidr: string; openclawVersion: string
    }>([
      {
        type: 'input',
        name: 'stackName',
        message: 'Deployment name: (a short label for this install, e.g. "prod", "home", "team-dev")',
        default: 'prod',
        validate: (v: string) => /^[a-z][a-z0-9-]{0,62}$/.test(v) || 'Use lowercase letters, numbers, and hyphens only',
      },
      ...(provider !== 'local' ? [
        {
          type: 'input',
          name: 'region',
          message: `Server region: (the geographic area where your server will live — pick closest to your users)`,
          default: defaultRegion(provider),
        },
        {
          type: 'list',
          name: 'instanceSize',
          message: 'Server size: (bigger = faster, but costs more per month)',
          choices: instanceChoices(provider),
        },
        {
          type: 'input',
          name: 'stateBucket',
          message: `${stateLabel(provider)} bucket name: (a storage bucket that tracks what's deployed — create one first if you haven't)`,
          validate: (v: string) => v.trim() !== '' || 'Required — create a bucket in your cloud console first',
        },
        {
          type: 'input',
          name: 'sshKeyPath',
          message: 'SSH public key file: (the .pub file that goes with your private key — used to access the new server)',
          default: `${detectSshKey()}.pub`,
        },
        {
          type: 'input',
          name: 'sshCidr',
          message: 'Restrict SSH access to: (your IP address for security, or 0.0.0.0/0 to allow access from anywhere)',
          default: '0.0.0.0/0',
        },
      ] as InquirerQuestion[] : []),
      {
        type: 'input',
        name: 'openclawVersion',
        message: 'OpenClaw version: ("latest" for the latest release, or a specific version like "2026.4")',
        default: 'latest',
      },
    ])

    // ── Step 4: LLM provider ───────────────────────────────────────────────────
    process.stdout.write('\n')
    info('Choose the AI model that your OpenClaw agent will use.')
    info('You\'ll need an API key from your chosen provider (except Bedrock and Ollama).\n')

    const { modelProviderId } = await inquirer.prompt<{ modelProviderId: string }>([{
      type: 'list',
      name: 'modelProviderId',
      message: 'Which AI provider do you want to use?',
      choices: catalogs.models.map((p) => ({ name: p.displayName, value: p.id })),
    }])

    const modelProvider = catalogs.models.find((p) => p.id === modelProviderId)!
    const modelConfig: Record<string, unknown> = {}
    const secrets: Array<{ name: string; source: 'env' | 'file'; ref: string }> = []

    const { selectedModelId } = await inquirer.prompt<{ selectedModelId: string }>([{
      type: 'list',
      name: 'selectedModelId',
      message: `Which ${modelProvider.displayName} model should OpenClaw use?`,
      choices: modelProvider.models.map((m) => ({
        name: m.family ? `[${m.family}] ${m.displayName}` : m.displayName,
        value: m.id,
      })),
      default: modelProvider.defaultModel,
    }])

    const selectedModel = modelProvider.models.find((m) => m.id === selectedModelId)!

    if (modelProvider.credentialSource === 'api-key') {
      const secretName = `${modelProviderId.toUpperCase()}_API_KEY`
      const entry = await promptSecret(secretName, `${modelProvider.displayName} API key`, modelProvider.envDefault ?? 'API_KEY', inquirer)
      secrets.push(entry)
      modelConfig['apiKey'] = `$secret:${secretName}`
    } else if (modelProvider.credentialSource === 'aws-profile') {
      process.stdout.write('\n')
      info(modelProvider.iamNote ?? 'Bedrock uses your AWS server\'s IAM role — no API key needed.')
      info('Make sure your EC2 instance has the AmazonBedrockFullAccess IAM policy attached.\n')
    } else if (modelProvider.id === 'ollama') {
      const { baseUrl } = await inquirer.prompt<{ baseUrl: string }>([{
        type: 'input',
        name: 'baseUrl',
        message: 'Ollama address: (the URL where Ollama is running — usually http://localhost:11434)',
        default: modelProvider.baseUrlDefault ?? 'http://localhost:11434',
      }])
      modelConfig['baseUrl'] = baseUrl
    }

    const builtModelConfig: Record<string, unknown> = {
      provider: modelProviderId,
      ...(selectedModel.modelId ? { modelId: selectedModel.modelId } : { model: selectedModel.id }),
      ...modelConfig,
    }

    // ── Step 5: Integrations ───────────────────────────────────────────────────
    process.stdout.write('\n')
    info('Use ↑↓ to move, Space to select/deselect, Enter to confirm.')

    const { selectedIntegrationIds } = await inquirer.prompt<{ selectedIntegrationIds: string[] }>([{
      type: 'checkbox',
      name: 'selectedIntegrationIds',
      message: 'Which chat integrations would you like to enable?',
      choices: catalogs.integrations.map((integ) => ({
        name: `${integ.displayName} — ${integ.description}`,
        value: integ.id,
        checked: false,
      })),
      pageSize: catalogs.integrations.length + 1,
    }])

    const channelsConfig: Record<string, Record<string, unknown>> = {}
    const infraRequired: Integration[] = []

    for (const integ of catalogs.integrations.filter((i) => selectedIntegrationIds.includes(i.id))) {
      process.stdout.write('\n')
      info(`Setting up ${integ.displayName}:`)

      const channelConfig: Record<string, unknown> = {}

      for (const field of integ.fields) {
        if (field.sensitive && field.envDefault) {
          const entry = await promptSecret(field.envDefault, `${integ.displayName} ${field.label}`, field.envDefault, inquirer)
          secrets.push(entry)
          channelConfig[field.name] = `$secret:${field.envDefault}`
        } else {
          const { value } = await inquirer.prompt<{ value: string }>([{
            type: 'input',
            name: 'value',
            message: `${field.label}: ${field.description}`,
            default: '',
          }])
          channelConfig[field.name] = value
        }
      }

      channelsConfig[integ.channelKey] = channelConfig
      if (integ.infraRequired) infraRequired.push(integ)
    }

    // ── Step 6: Output directory ───────────────────────────────────────────────
    // Local provider: skip the prompt — always write alongside the cwd; the file
    // is a useful record but the deploy-now path doesn't need the user to pick a dir.
    let outDir = typeof args['output-dir'] === 'string' ? args['output-dir'] : null
    if (outDir === null) {
      if (provider !== 'local') {
        const { outputDir } = await inquirer.prompt<{ outputDir: string }>([{
          type: 'input',
          name: 'outputDir',
          message: 'Where should the plan file be saved? (press Enter to save in the current folder)',
          default: '.',
        }])
        outDir = outputDir
      } else {
        outDir = '.'
      }
    }

    // ── Step 7: Build and write output ─────────────────────────────────────────

    // Generate a gateway auth token and persist it locally so the user can
    // retrieve it later from ~/.clawops/secrets/GATEWAY_TOKEN.
    const gatewayToken = randomBytes(24).toString('hex')
    const secretsDir = path.join(os.homedir(), '.clawops', 'secrets')
    mkdirSync(secretsDir, { recursive: true })
    spawnSync('chmod', ['700', secretsDir], { stdio: 'ignore' })
    // Per-stack token file: running setup for a second stack won't clobber the first.
    const tokenPath = path.join(secretsDir, `GATEWAY_TOKEN_${stackAnswers.stackName}`)
    writeFileSync(tokenPath, gatewayToken, { encoding: 'utf-8', mode: 0o600 })

    const openclawConfigOverlay: Record<string, unknown> = {
      models: builtModelConfig,
      gateway: { auth: { mode: 'token', token: gatewayToken } },
    }
    if (Object.keys(channelsConfig).length > 0) {
      openclawConfigOverlay['channels'] = channelsConfig
    }

    let outputPath: string

    if (provider === 'local') {
      outputPath = path.join(outDir, `openclaw-${stackAnswers.stackName}.json`)
      writeFileSync(outputPath, JSON.stringify(openclawConfigOverlay, null, 2), 'utf-8')
      process.stdout.write('\n')
      success(`Config file saved to ${outputPath}`)
    } else {
      let sshPublicKey = ''
      try {
        sshPublicKey = readFileSync(stackAnswers.sshKeyPath ?? '', 'utf-8').trim()
      } catch {
        failure(`Cannot read SSH public key at ${stackAnswers.sshKeyPath ?? ''}`)
        process.exit(1)
      }

      const plan = {
        apiVersion: 'clawops.dev/v1',
        kind: 'DeployPlan',
        metadata: {
          name: stackAnswers.stackName,
          generatedAt: new Date().toISOString(),
          generator: 'clawops-setup',
        },
        spec: {
          provider,
          region: stackAnswers.region,
          stackName: stackAnswers.stackName,
          instanceType: stackAnswers.instanceSize,
          openclaw: {
            version: stackAnswers.openclawVersion,
            config: openclawConfigOverlay,
            ...(Object.keys(channelsConfig).length > 0 ? { channels: channelsConfig } : {}),
          },
          secrets,
          network: {
            allowedSshCidrs: [stackAnswers.sshCidr ?? '0.0.0.0/0'],
            allowedGatewayCidrs: [stackAnswers.sshCidr ?? '0.0.0.0/0'],
          },
          ssh: { publicKey: sshPublicKey },
          ...(stackAnswers.stateBucket ? { stateBucket: stackAnswers.stateBucket } : {}),
        },
      }

      outputPath = path.join(outDir, `clawops-${stackAnswers.stackName}-plan.json`)
      writeFileSync(outputPath, JSON.stringify(plan, null, 2), 'utf-8')
      process.stdout.write('\n')
      success(`Deployment plan saved to ${outputPath}`)
    }

    // ── Step 8: AI app integration ─────────────────────────────────────────────
    process.stdout.write('\n')

    const mcpEntry = buildMcpEntry()
    if (!mcpEntry.resolved) {
      info('Note: clawops is not installed globally — AI apps will not be able to start')
      info('the MCP server until you install it:')
      info('  npm install -g @clawops/cli')
      info('The config will be written now; re-run setup after installing to update the path.\n')
    }

    info('Use ↑↓ to move, Space to select/deselect, Enter to confirm.')

    const appChoices = MCP_APPS.map((app) => ({
      name: app.isInstalled() ? app.name : `${app.name}  (not detected — config will be written anyway)`,
      value: app.id,
      checked: app.isInstalled(),
    }))

    const { selectedAppIds } = await inquirer.prompt<{ selectedAppIds: string[] }>([{
      type: 'checkbox',
      name: 'selectedAppIds',
      message: 'Connect clawops to your AI apps? (space to toggle, enter to skip)',
      choices: appChoices,
      pageSize: MCP_APPS.length + 1,
    }])

    const selectedApps = MCP_APPS.filter((app) => selectedAppIds.includes(app.id))

    if (selectedApps.length > 0) {
      const results = writeAppConfigs(selectedApps, { command: mcpEntry.command, args: mcpEntry.args })
      for (const r of results) {
        if (r.ok) {
          success(`${r.app.name} configured  (${r.configPath})`)
        } else {
          failure(`Could not configure ${r.app.name}: ${r.error ?? 'unknown error'}`)
          info('Add this to its MCP config manually:')
          printMcpSnippet()
        }
      }
      const needsRestart = selectedApps.filter((app) => app.id !== 'claude-code')
      if (needsRestart.length > 0) {
        info(`Restart ${needsRestart.map((a) => a.name).join(', ')} to load the clawops tool.`)
      }
    } else {
      info('To connect clawops to an AI app later, add this to its MCP config:')
      printMcpSnippet()
      info('Config paths:')
      for (const app of MCP_APPS) {
        info(`  ${app.name.padEnd(18)} ${app.configPath()}`)
      }
    }

    // ── Step 9: Post-setup notes ───────────────────────────────────────────────
    if (infraRequired.length > 0) {
      process.stdout.write('\n')
      info('── Action required: webhook registration ────────────────────────────')
      info('These integrations need a webhook URL set up in their developer portal:')
      for (const integ of infraRequired) {
        info(`\n  ${integ.displayName}`)
        if (integ.infraNote) info(`  ${integ.infraNote.trim()}`)
        if (integ.setupUrl) info(`  Guide: ${integ.setupUrl}`)
      }
    }

    if (modelProvider.id === 'ollama' && selectedModel.pullSuffix !== undefined) {
      process.stdout.write('\n')
      info('── Action required: download the Ollama model ───────────────────────')
      info('After deployment, run this command on the server (or locally if Ollama is local):')
      info(`  ollama pull ${selectedModel.id}${selectedModel.pullSuffix}`)
    }

    // ── Step 10: Deploy ────────────────────────────────────────────────────────
    if (dryRun) return

    if (provider === 'local') {
      const { deployNow } = await inquirer.prompt<{ deployNow: boolean }>([{
        type: 'confirm',
        name: 'deployNow',
        message: 'Initialize and deploy the server now? (connects over SSH — takes 2–5 min)',
        default: true,
      }])

      if (deployNow) {
        await runLocalDeploy({
          stackName: stackAnswers.stackName,
          host: localHost,
          port: localPort,
          user: localUser,
          keyPath: localKeyPath,
          sudoPassword: localSudoPassword || undefined,
          openclawVersion: stackAnswers.openclawVersion,
          overlay: openclawConfigOverlay,
          secrets,
          gatewayToken,
          signal: ac.signal,
          inquirer,
        })
      } else {
        const { getConfigDir } = await import('../../config/store.js')
        const knownHostsPath = path.join(getConfigDir(), 'known_hosts')
        process.stdout.write('\n')
        info('To deploy later, run these two commands:')
        info(`  clawops init --provider local --host ${localHost} --port ${localPort} --user ${localUser} --key ${localKeyPath} --stack ${stackAnswers.stackName}`)
        info(`  clawops up --stack ${stackAnswers.stackName} --config ${outputPath}`)
        info(`\n(SSH host verification will be saved to ${knownHostsPath})`)
      }
    } else {
      const { applyNow } = await inquirer.prompt<{ applyNow: boolean }>([{
        type: 'confirm',
        name: 'applyNow',
        message: 'Provision the cloud server now? (creates the server and installs OpenClaw — takes 3–5 minutes)',
        default: false,
      }])

      if (applyNow) {
        const { applyPlan } = await import('../../plan/apply.js')
        const plan = JSON.parse(readFileSync(outputPath, 'utf-8')) as Parameters<typeof applyPlan>[0]
        try {
          await applyPlan(plan, {
            onOutput: (line) => process.stdout.write(line),
            signal: ac.signal,
          })
          success('Server provisioned and OpenClaw installed.')
          info(`Run: clawops doctor --stack ${stackAnswers.stackName}  to verify everything is healthy`)
        } catch (err) {
          failure(err instanceof Error ? err.message : String(err))
          process.exit(1)
        }
      } else {
        info(`\nTo deploy later:  clawops apply ${outputPath}`)
      }
    }
  },
})

// ── Local deploy ──────────────────────────────────────────────────────────────

interface LocalDeployOpts {
  stackName: string
  host: string
  port: number
  user: string
  keyPath: string
  sudoPassword?: string
  openclawVersion: string
  overlay: Record<string, unknown>
  secrets: Array<{ name: string; source: 'env' | 'file'; ref: string }>
  gatewayToken: string
  signal?: AbortSignal
  inquirer: InquirerInstance
}

async function runLocalDeploy(opts: LocalDeployOpts): Promise<void> {
  const { setConfig, getConfig, getConfigDir } = await import('../../config/store.js')
  const { localBootstrap } = await import('../../providers/local/bootstrap.js')
  const { connect } = await import('../../transport/ssh.js')
  const { readRemoteConfig, atomicWriteConfig, restartGateway, deepMerge } = await import('../../plan/remote-config.js')
  const { resolveSecrets } = await import('../../plan/secrets.js')

  const knownHostsPath = path.join(getConfigDir(), 'known_hosts')

  // Register stack in ~/.clawops/config.json
  const existing = getConfig()
  const stackEntry = {
    provider: 'local' as const,
    stateUrl: 'file://~/.clawops/state',
    credentialsRef: { source: 'file' as const, envVars: [] as string[] },
    localOpts: { host: opts.host, sshUser: opts.user, sshPort: opts.port, sshKeyPath: opts.keyPath },
  }
  const newConfig: ClawopsConfig = existing
    ? { ...existing, defaults: { stack: opts.stackName, provider: 'local' }, stacks: { ...existing.stacks, [opts.stackName]: stackEntry } }
    : {
        version: 1,
        defaults: { stack: opts.stackName, provider: 'local' },
        stacks: { [opts.stackName]: stackEntry },
        ssh: { keyPath: opts.keyPath, knownHostsPath },
      }
  setConfig(newConfig)
  success(`Deployment "${opts.stackName}" registered  (~/.clawops/config.json)`)

  // Preflight: verify Docker is installed and running on the target host
  await checkDockerPreflight({ host: opts.host, port: opts.port, user: opts.user, keyPath: opts.keyPath, knownHostsPath, signal: opts.signal, inquirer: opts.inquirer })

  // Bootstrap the host — stream output to drive spinner text
  const STAGES: Array<[RegExp, string]> = [
    [/apt-get update|dnf|yum|apk update/i,                     'Updating package lists...'],
    [/apt-get install|dnf install|yum install|apk add/i,        'Installing dependencies...'],
    [/docker-ce|containerd|docker\.io|Install Docker/i,         'Installing Docker...'],
    [/Pulling from|docker pull|Pull complete|Already exists/i,  'Pulling OpenClaw image...'],
    [/systemctl|rc-update|docker run|ExecStart/i,               'Starting OpenClaw service...'],
    [/bootstrap complete/i,                                      'Waiting for OpenClaw to start...'],
  ]

  const spin = spinner(`Connecting to ${opts.host}...`)
  let state: { gatewayUrl: string; sshUser: string; sshHost: string; sshPort: number }
  try {
    state = await localBootstrap({
      host: opts.host,
      port: opts.port,
      user: opts.user,
      privateKeyPath: opts.keyPath,
      knownHostsPath,
      openclawVersion: opts.openclawVersion,
      stackName: opts.stackName,
      sudoPassword: opts.sudoPassword,
      noWait: false,
      onOutput: (line) => {
        for (const [pattern, label] of STAGES) {
          if (pattern.test(line)) { spin.text = label; break }
        }
      },
      signal: opts.signal,
    })
    spin.succeed(`OpenClaw installed on ${opts.host}`)
  } catch (err) {
    spin.fail('Installation failed')
    throw err
  }

  // Apply config overlay
  const spin2 = spinner('Applying your configuration...')
  try {
    const session = await connect({
      host: opts.host,
      port: opts.port,
      user: opts.user,
      privateKeyPath: opts.keyPath,
      knownHostsPath,
      signal: opts.signal,
    })
    try {
      const remote = await readRemoteConfig(session, opts.signal)
      const resolved = resolveSecrets(opts.overlay, opts.secrets) as Record<string, unknown>
      const merged = deepMerge(remote, resolved)
      await atomicWriteConfig(session, merged, opts.signal)
      await restartGateway(session, opts.signal)
      const { saveOverlay } = await import('../../plan/overlay-store.js')
      saveOverlay(opts.stackName, opts.overlay, opts.secrets)
    } finally {
      session.close()
    }
    spin2.succeed('Configuration applied')
  } catch (err) {
    spin2.fail('Configuration failed')
    throw err
  }

  const { drainPool } = await import('../../transport/pool.js')
  drainPool()

  const tokenPath = path.join(os.homedir(), '.clawops', 'secrets', `GATEWAY_TOKEN_${opts.stackName}`)
  const dashboardUrl = `${state.gatewayUrl}?token=${opts.gatewayToken}`

  process.stdout.write('\n')
  success('All done! OpenClaw is running.')
  info(`Open dashboard: ${dashboardUrl}`)
  info(`  (or enter the token manually in the "Gateway Token" field: ${opts.gatewayToken})`)
  info(`SSH access:     ${state.sshUser}@${state.sshHost}:${state.sshPort}`)
  info(`Token saved to  ${tokenPath}`)
  info(`\nRun  clawops doctor --stack ${opts.stackName}  to check everything is healthy`)
  printCta()
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const CLOUD_AUTH: Record<'aws' | 'gcp' | 'azure', {
  check: () => string
  identity: (out: string) => string
  loginCmd: string[]
  loginHint: string
}> = {
  aws: {
    check: () => execSync('aws sts get-caller-identity --query Account --output text', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(),
    identity: (out) => `AWS account ${out}`,
    loginCmd: ['aws', 'configure'],
    loginHint: 'This will walk you through entering your Access Key ID and Secret.',
  },
  gcp: {
    check: () => {
      const acct = execSync('gcloud config get-value account 2>/dev/null', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
      if (!acct || acct === '(unset)') throw new Error('not authenticated')
      return acct
    },
    identity: (out) => `GCP account ${out}`,
    loginCmd: ['gcloud', 'auth', 'login'],
    loginHint: 'This will open a browser window to sign in to your Google account.',
  },
  azure: {
    check: () => execSync('az account show --query user.name --output tsv', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(),
    identity: (out) => `Azure user ${out}`,
    loginCmd: ['az', 'login'],
    loginHint: 'This will open a browser window to sign in to your Azure account.',
  },
}

async function ensureCloudAuth(
  provider: 'aws' | 'gcp' | 'azure',
  inquirer: InquirerInstance,
): Promise<void> {
  const cfg = CLOUD_AUTH[provider]

  // Check if already authenticated
  try {
    const identity = cfg.check()
    success(`Authenticated: ${cfg.identity(identity)}`)
    return
  } catch {
    // Not authenticated — guide the user
  }

  const cliName = cfg.loginCmd[0]
  failure(`Not signed in to ${provider.toUpperCase()}. You need to authenticate before deploying.`)
  info(`\nTo authenticate, run:\n  ${cfg.loginCmd.join(' ')}\n${cfg.loginHint}`)

  const { runNow } = await inquirer.prompt<{ runNow: boolean }>([{
    type: 'confirm',
    name: 'runNow',
    message: `Run \`${cfg.loginCmd.join(' ')}\` now?`,
    default: true,
  }])

  if (runNow) {
    process.stdout.write('\n')
    const result = spawnSync(cfg.loginCmd[0], cfg.loginCmd.slice(1), { stdio: 'inherit' })
    if (result.error) {
      failure(`Could not launch ${cliName} — is it installed? (${result.error.message})`)
      info(`Install guide: ${cliInstallUrl(provider)}`)
      info('Re-run `clawops setup` after installing and signing in.\n')
      return
    }
    // Re-check after login attempt
    try {
      const identity = cfg.check()
      process.stdout.write('\n')
      success(`Authenticated: ${cfg.identity(identity)}`)
    } catch {
      process.stdout.write('\n')
      failure(`Still not authenticated — the sign-in may have been cancelled or failed.`)
      info('Re-run `clawops setup` after signing in, or continue and authenticate before running `clawops up`.\n')
    }
  } else {
    info('You can authenticate later, but `clawops up` will fail until you do.\n')
  }
}

function cliInstallUrl(provider: 'aws' | 'gcp' | 'azure'): string {
  if (provider === 'aws') return 'https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2.html'
  if (provider === 'gcp') return 'https://cloud.google.com/sdk/docs/install'
  return 'https://learn.microsoft.com/en-us/cli/azure/install-azure-cli'
}

async function promptSecret(
  name: string,
  label: string,
  envDefault: string,
  inquirer: InquirerInstance,
): Promise<{ name: string; source: 'env' | 'file'; ref: string }> {
  const secretsDir = path.join(os.homedir(), '.clawops', 'secrets')
  const { secretSource } = await inquirer.prompt<{ secretSource: 'env' | 'file' | 'paste' }>([{
    type: 'list',
    name: 'secretSource',
    message: `Where is your ${label}?`,
    choices: [
      { name: `Paste it here — saved to ~/.clawops/secrets/${name}`, value: 'paste' },
      { name: `In an environment variable  (e.g. ${envDefault})`, value: 'env' },
      { name: 'In a file on this computer', value: 'file' },
    ],
  }])

  if (secretSource === 'paste') {
    const { secretValue } = await inquirer.prompt<{ secretValue: string }>([{
      type: 'password',
      name: 'secretValue',
      message: `Paste your ${label}: (input is hidden)`,
      validate: (v: string) => v.trim() !== '' || 'Value cannot be empty',
    }])
    mkdirSync(secretsDir, { recursive: true })
    spawnSync('chmod', ['700', secretsDir], { stdio: 'ignore' })
    const secretPath = path.join(secretsDir, name)
    writeFileSync(secretPath, secretValue.trim(), { encoding: 'utf-8', mode: 0o600 })
    success(`Secret saved to ${secretPath}  (chmod 600)`)
    return { name, source: 'file', ref: secretPath }
  }

  if (secretSource === 'env') {
    const { envVar } = await inquirer.prompt<{ envVar: string }>([{
      type: 'input',
      name: 'envVar',
      message: `Environment variable name: (the variable that holds your ${label})`,
      default: envDefault,
    }])
    return { name, source: 'env', ref: envVar }
  }

  const { filePath } = await inquirer.prompt<{ filePath: string }>([{
    type: 'input',
    name: 'filePath',
    message: `File path: (full path to the file containing your ${label})`,
    validate: (v: string) => existsSync(v.trim()) || `File not found: ${v.trim()}`,
  }])
  return { name, source: 'file', ref: filePath }
}

// Docker preflight check — runs before bootstrap so the user gets a clear message
// instead of a cryptic bootstrap failure mid-way through.
// `docker info` can hang indefinitely waiting for the daemon socket.
// Use `docker version` instead (faster API call) and cap the whole check at 10s.
// If the check times out we warn and proceed — the bootstrap script will give
// a clearer error if Docker truly isn't usable.
const DOCKER_PREFLIGHT_TIMEOUT_MS = 10_000

// Docker Desktop on Apple Silicon uses ~/.docker/run/docker.sock, not /var/run/docker.sock.
// Try the default socket first, then the Docker Desktop user socket, then Colima's socket.
const DOCKER_CHECK_CMD = [
  'export PATH="/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:$PATH"',
  'if ! command -v docker >/dev/null 2>&1; then echo NOT_INSTALLED; exit 0; fi',
  'if docker version >/dev/null 2>&1; then echo OK; exit 0; fi',
  'if DOCKER_HOST="unix://${HOME}/.docker/run/docker.sock" docker version >/dev/null 2>&1; then echo OK; exit 0; fi',
  'if DOCKER_HOST="unix://${HOME}/.colima/default/docker.sock" docker version >/dev/null 2>&1; then echo OK; exit 0; fi',
  'echo NOT_RUNNING',
].join('; ')

async function checkDockerPreflight(opts: {
  host: string; port: number; user: string; keyPath: string; knownHostsPath: string
  signal?: AbortSignal; inquirer: InquirerInstance
}): Promise<void> {
  const { acquireSession } = await import('../../transport/pool.js')
  const { ProviderError } = await import('../../errors/index.js')

  const spin = spinner('Checking Docker on target host...')

  // Combine the caller's signal with a hard 10-second timeout
  const timeoutSignal = AbortSignal.timeout(DOCKER_PREFLIGHT_TIMEOUT_MS)
  const execSignal = opts.signal
    ? AbortSignal.any([opts.signal, timeoutSignal])
    : timeoutSignal

  const { session, release } = await acquireSession({
    host: opts.host, port: opts.port, user: opts.user,
    privateKeyPath: opts.keyPath, knownHostsPath: opts.knownHostsPath, signal: opts.signal,
  })

  let out = ''
  try {
    const result = await session.exec(DOCKER_CHECK_CMD, execSignal)
    out = result.stdout.trim()
  } catch {
    // Timed out or aborted — don't block the deploy; let bootstrap handle it
    spin.warn('Docker check timed out — proceeding anyway. Bootstrap will verify.')
    return
  } finally {
    release()
  }

  if (out === 'OK') {
    spin.succeed('Docker is installed and running.')
    return
  }

  if (out === 'NOT_RUNNING') {
    if (!LOCALHOST_ALIASES.has(opts.host.toLowerCase())) {
      // Remote server: start Docker via SSH instead of locally.
      await startRemoteDocker(opts, spin)
      return
    }
    spin.warn('Docker is installed but not running.')
    await startDockerAndWait(opts.inquirer)
    return
  }

  // NOT_INSTALLED or empty output
  spin.fail('Docker not found on the target host.')
  info('Install Docker with one of:')
  info('  Docker Desktop (GUI):  https://www.docker.com/products/docker-desktop/')
  info('  Homebrew:              brew install --cask docker')
  info('  Colima (FOSS):         brew install colima docker && colima start')
  info('Then re-run: clawops setup')
  throw new ProviderError('Docker is not installed on the target host.')
}

const DOCKER_POLL_MS = 3_000
const DOCKER_TIMEOUT_MS = 90_000

async function startRemoteDocker(
  opts: { host: string; port: number; user: string; keyPath: string; knownHostsPath: string; signal?: AbortSignal },
  spin: ReturnType<typeof spinner>,
): Promise<void> {
  const { acquireSession } = await import('../../transport/pool.js')
  const { ProviderError } = await import('../../errors/index.js')

  spin.text = 'Starting Docker on the remote server...'

  const { session, release } = await acquireSession({
    host: opts.host, port: opts.port, user: opts.user,
    privateKeyPath: opts.keyPath, knownHostsPath: opts.knownHostsPath, signal: opts.signal,
  })

  try {
    const startResult = await session.exec(
      'sudo systemctl start docker 2>/dev/null || sudo service docker start 2>/dev/null',
      opts.signal,
    )
    if (startResult.code !== 0) {
      spin.fail('Could not start Docker on the remote server.')
      throw new ProviderError(
        'Start Docker manually (sudo systemctl start docker) and re-run: clawops setup',
      )
    }

    const deadline = Date.now() + DOCKER_TIMEOUT_MS
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, DOCKER_POLL_MS))
      spin.text = `Waiting for Docker to start on ${opts.host}...`
      const check = await session.exec(
        'docker version >/dev/null 2>&1 && echo OK || echo NOT_RUNNING',
        opts.signal,
      )
      if (check.stdout.trim() === 'OK') {
        spin.succeed('Docker started on the remote server.')
        return
      }
    }

    spin.fail('Docker did not start within 90s on the remote server.')
    throw new ProviderError(
      'Docker did not become ready. Start it manually and re-run: clawops setup',
    )
  } finally {
    release()
  }
}

function dockerIsReachable(): boolean {
  try {
    execSync(
      'docker version >/dev/null 2>&1 || ' +
      'DOCKER_HOST="unix://$HOME/.docker/run/docker.sock" docker version >/dev/null 2>&1 || ' +
      'DOCKER_HOST="unix://$HOME/.colima/default/docker.sock" docker version >/dev/null 2>&1',
      { stdio: 'ignore' },
    )
    return true
  } catch {
    return false
  }
}

async function pollUntilDockerReady(label: string): Promise<void> {
  const spin = spinner(label)
  const deadline = Date.now() + DOCKER_TIMEOUT_MS
  let elapsed = 0
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, DOCKER_POLL_MS))
    elapsed += DOCKER_POLL_MS
    spin.text = `${label} (${Math.round(elapsed / 1000)}s)`
    if (dockerIsReachable()) {
      spin.succeed('Docker is running.')
      return
    }
  }
  spin.fail('Docker did not start within 90s.')
  info('Check Docker Desktop for errors, then re-run: clawops setup')
  throw new Error('Docker daemon did not become ready within timeout.')
}

async function startDockerAndWait(inquirer: InquirerInstance): Promise<void> {
  const isLinux = process.platform === 'linux'
  const { choice } = await inquirer.prompt<{
    choice: 'dockerd' | 'systemctl' | 'desktop' | 'colima' | 'skip'
  }>([{
    type: 'list',
    name: 'choice',
    message: 'How would you like to start Docker?',
    choices: [
      ...(isLinux ? [{ name: 'Start daemon directly  (sudo dockerd)', value: 'dockerd' as const }] : []),
      ...(isLinux ? [{ name: 'systemctl             (sudo systemctl start docker)', value: 'systemctl' as const }] : []),
      ...(!isLinux ? [{ name: 'Docker Desktop        (open -a Docker)', value: 'desktop' as const }] : []),
      { name: 'Colima               (colima start)', value: 'colima' as const },
      { name: 'Skip — I\'ll start it myself and re-run clawops setup', value: 'skip' as const },
    ],
  }])

  if (choice === 'skip') {
    info('Re-run `clawops setup` once Docker is running.')
    throw new Error('Docker not running — user chose to exit.')
  }

  if (choice === 'dockerd') {
    info('Starting dockerd in the background (you may be prompted for your password)...')
    const child = spawn('sudo', ['dockerd'], { detached: true, stdio: 'ignore' })
    child.unref()
    await pollUntilDockerReady('Waiting for Docker daemon...')

  } else if (choice === 'systemctl') {
    const spin = spinner('Running: sudo systemctl start docker...')
    const res = spawnSync('sudo', ['systemctl', 'start', 'docker'], { stdio: 'pipe' })
    if (res.status !== 0) {
      spin.fail('systemctl start docker failed.')
      throw new Error('systemctl start docker failed')
    }
    spin.succeed('Docker service started.')
    await pollUntilDockerReady('Waiting for Docker daemon to be reachable...')

  } else if (choice === 'desktop') {
    const backendRunning = spawnSync('pgrep', ['-f', 'com.docker.backend'], { stdio: 'ignore' }).status === 0
    if (backendRunning) {
      const killSpin = spinner('Docker Desktop is stuck — force-restarting...')
      for (const pat of ['com.docker.backend', 'com.docker.virtualization', 'com.docker.build', 'Docker Desktop']) {
        spawnSync('pkill', ['-9', '-f', pat], { stdio: 'ignore' })
      }
      await new Promise((r) => setTimeout(r, 2_000))
      killSpin.succeed('Old Docker processes cleared.')
    }

    const openSpin = spinner('Launching Docker Desktop...')
    let opened = spawnSync('open', ['-a', 'Docker'], { stdio: 'ignore' })
    if (opened.status !== 0) opened = spawnSync('open', ['/Applications/Docker.app'], { stdio: 'ignore' })
    if (opened.status !== 0) {
      openSpin.fail('Could not open Docker Desktop — is it installed in /Applications?')
      throw new Error('Failed to open Docker Desktop')
    }
    openSpin.succeed('Docker Desktop launched.')
    await pollUntilDockerReady('Waiting for Docker engine to start...')

  } else if (choice === 'colima') {
    const spin = spinner('Running: colima start...')
    const res = spawnSync('colima', ['start'], { stdio: 'pipe' })
    if (res.status !== 0) {
      spin.fail('colima start failed — is Colima installed? (brew install colima docker)')
      throw new Error('colima start failed')
    }
    spin.succeed('Colima started.')
    await pollUntilDockerReady('Waiting for Docker daemon to be reachable...')
  }
}

const LOCALHOST_ALIASES = new Set(['localhost', '127.0.0.1', '::1'])

async function ensureAuthorizedKey(
  keyPath: string,
  host: string,
  inquirer: InquirerInstance,
): Promise<void> {
  const pubKeyPath = `${keyPath}.pub`
  if (!existsSync(pubKeyPath)) return

  const pubKey = readFileSync(pubKeyPath, 'utf-8').trim()
  const isLocal = LOCALHOST_ALIASES.has(host.toLowerCase())
  const authorizedKeysPath = path.join(os.homedir(), '.ssh', 'authorized_keys')

  if (isLocal) {
    // Check if the key is already authorised
    const existing = existsSync(authorizedKeysPath)
      ? readFileSync(authorizedKeysPath, 'utf-8')
      : ''
    if (existing.includes(pubKey)) {
      success('SSH public key is already in authorized_keys.')
      return
    }

    info('\nConnecting to localhost requires your public key to be in ~/.ssh/authorized_keys.')
    const { addKey } = await inquirer.prompt<{ addKey: boolean }>([{
      type: 'confirm',
      name: 'addKey',
      message: 'Add your public key to ~/.ssh/authorized_keys now? (required for SSH to work)',
      default: true,
    }])

    if (addKey) {
      mkdirSync(path.join(os.homedir(), '.ssh'), { recursive: true })
      const entry = existing.endsWith('\n') || existing === '' ? pubKey + '\n' : '\n' + pubKey + '\n'
      writeFileSync(authorizedKeysPath, existing + entry, { encoding: 'utf-8', flag: 'a' })
      spawnSync('chmod', ['600', authorizedKeysPath], { stdio: 'ignore' })
      success('Public key added to ~/.ssh/authorized_keys.')
    } else {
      info('SSH will likely fail. Add this line to ~/.ssh/authorized_keys manually:')
      info(`  ${pubKey}`)
    }
  } else {
    // Remote server — just show the key so the user can add it themselves
    process.stdout.write('\n')
    info('Make sure this public key is in ~/.ssh/authorized_keys on your server:')
    info(`  ${pubKey}`)
    info('(If you just created the server, paste the line above into the server\'s ~/.ssh/authorized_keys file.)\n')
  }
}

async function generateSshKey(): Promise<string> {
  const keyPath = path.join(os.homedir(), '.ssh', 'id_ed25519')
  mkdirSync(path.join(os.homedir(), '.ssh'), { recursive: true })
  const result = spawnSync('ssh-keygen', ['-t', 'ed25519', '-f', keyPath, '-N', '', '-C', 'clawops'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    throw new Error(`ssh-keygen failed: ${result.stderr?.toString().trim()}`)
  }
  success(`SSH key pair generated: ${keyPath}`)
  info(`Public key (add this to your server's ~/.ssh/authorized_keys if needed):\n  ${readFileSync(`${keyPath}.pub`, 'utf-8').trim()}`)
  return keyPath
}

function detectSshKey(): string {
  const candidates = ['id_ed25519', 'id_ecdsa', 'id_rsa', 'id_dsa']
  for (const name of candidates) {
    const p = path.join(os.homedir(), '.ssh', name)
    if (existsSync(p)) return p
  }
  return path.join(os.homedir(), '.ssh', 'id_ed25519')
}


function printMcpSnippet(): void {
  process.stdout.write('\n')
  process.stdout.write(JSON.stringify({
    mcpServers: {
      clawops: { command: 'clawops', args: ['mcp', 'serve', '--read-only'] },
    },
  }, null, 2) + '\n\n')
}

function loadCatalogs(yaml: typeof import('js-yaml')): Catalogs {
  const specDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../spec')
  try {
    const modelsRaw = yaml.load(readFileSync(path.join(specDir, 'models.yaml'), 'utf-8'))
    const integrationsRaw = yaml.load(readFileSync(path.join(specDir, 'integrations.yaml'), 'utf-8'))
    return {
      models: (modelsRaw as { providers: ModelProvider[] }).providers,
      integrations: (integrationsRaw as { integrations: Integration[] }).integrations,
    }
  } catch (err) {
    throw new Error(`Cannot load wizard catalogs from spec/: ${(err as Error).message}`)
  }
}

function defaultRegion(provider: string): string {
  if (provider === 'aws') return 'us-east-1'
  if (provider === 'gcp') return 'us-central1'
  if (provider === 'azure') return 'eastus'
  return ''
}

function stateLabel(provider: string): string {
  if (provider === 'aws') return 'S3'
  if (provider === 'gcp') return 'GCS'
  if (provider === 'azure') return 'Azure Blob Storage'
  return 'State'
}

function instanceChoices(provider: string): Array<{ name: string; value: string }> {
  const table: Record<string, Array<{ name: string; value: string }>> = {
    aws: [
      { name: 'micro  — 1 CPU, 1 GB RAM  (~$8/mo)   — light personal use', value: 'micro' },
      { name: 'small  — 2 CPU, 2 GB RAM  (~$17/mo)  — recommended for most users', value: 'small' },
      { name: 'medium — 2 CPU, 4 GB RAM  (~$33/mo)  — teams or heavy usage', value: 'medium' },
      { name: 'large  — 2 CPU, 8 GB RAM  (~$67/mo)  — high traffic or multiple agents', value: 'large' },
    ],
    gcp: [
      { name: 'micro  — 2 CPU, 1 GB RAM  (~$7/mo)   — light personal use', value: 'micro' },
      { name: 'small  — 2 CPU, 8 GB RAM  (~$49/mo)  — recommended for most users', value: 'small' },
      { name: 'medium — 4 CPU, 16 GB RAM (~$97/mo)  — teams or heavy usage', value: 'medium' },
      { name: 'large  — 8 CPU, 32 GB RAM (~$194/mo) — high traffic or multiple agents', value: 'large' },
    ],
    azure: [
      { name: 'micro  — 1 CPU, 1 GB RAM  (~$8/mo)   — light personal use', value: 'micro' },
      { name: 'small  — 2 CPU, 4 GB RAM  (~$35/mo)  — recommended for most users', value: 'small' },
      { name: 'medium — 4 CPU, 8 GB RAM  (~$70/mo)  — teams or heavy usage', value: 'medium' },
      { name: 'large  — 8 CPU, 16 GB RAM (~$140/mo) — high traffic or multiple agents', value: 'large' },
    ],
  }
  return table[provider] ?? []
}
