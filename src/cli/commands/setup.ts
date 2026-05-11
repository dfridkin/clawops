// clawops setup — interactive wizard for first-run configuration.
// Produces a deploy plan (cloud) or openclaw config overlay (local) and
// optionally applies it. Reads spec/models.yaml and spec/integrations.yaml
// at runtime; no codegen needed for those catalog files.

import { defineCommand } from 'citty'
import process from 'node:process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { success, failure, info } from '../../output/human.js'

// Minimal typing shim for inquirer v9 (ships no bundled .d.ts).
interface InquirerQuestion {
  type: string
  name: string
  message: string
  choices?: Array<{ name: string; value: unknown }>
  default?: unknown
  validate?: (v: string) => boolean | string
}
interface InquirerInstance {
  prompt<T>(questions: InquirerQuestion[]): Promise<T>
}

// Catalog types — mirrors spec/models.yaml and spec/integrations.yaml shape.
interface ModelEntry {
  id: string
  displayName: string
  modelId?: string   // Bedrock-specific API model ID
  family?: string
  recommended?: boolean
  pullSuffix?: string  // Ollama tag hint
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
    'output-dir': { type: 'string', description: 'Directory to write generated files (default: .)' },
  },
  async run({ args }) {
    const inquirer = (await import('inquirer')).default as unknown as InquirerInstance
    const yaml = await import('js-yaml')

    const catalogs = loadCatalogs(yaml)
    const outDir = typeof args['output-dir'] === 'string' ? args['output-dir'] : '.'
    const dryRun = Boolean(args['dry-run'])

    const ac = new AbortController()
    process.on('SIGINT', () => { ac.abort(); process.exit(130) })
    process.on('SIGTERM', () => { ac.abort(); process.exit(143) })

    // ── Step 1: Deployment type ────────────────────────────────────────────────
    const { deploymentType } = await inquirer.prompt<{ deploymentType: 'cloud' | 'local' }>([{
      type: 'list',
      name: 'deploymentType',
      message: 'What type of deployment?',
      choices: [
        { name: 'Cloud  (AWS, GCP, or Azure)', value: 'cloud' },
        { name: 'Local  (SSH to an existing Linux or macOS machine)', value: 'local' },
      ],
    }])

    // ── Step 2: Provider ───────────────────────────────────────────────────────
    let provider: 'aws' | 'gcp' | 'azure' | 'local'
    let localHost = ''
    let localUser = 'ubuntu'
    let localKeyPath = `${process.env['HOME'] ?? '~'}/.ssh/id_rsa`
    let localPort = 22

    if (deploymentType === 'cloud') {
      const answer = await inquirer.prompt<{ provider: 'aws' | 'gcp' | 'azure' }>([{
        type: 'list',
        name: 'provider',
        message: 'Which cloud provider?',
        choices: [
          { name: 'AWS   (EC2 + Elastic IP)', value: 'aws' },
          { name: 'GCP   (Compute Engine + static IP)', value: 'gcp' },
          { name: 'Azure (VM + public IP)', value: 'azure' },
        ],
      }])
      provider = answer.provider
    } else {
      provider = 'local'
      const localAnswers = await inquirer.prompt<{
        host: string; port: number; user: string; keyPath: string
      }>([
        { type: 'input', name: 'host', message: 'SSH host (IP or hostname):', validate: (v: string) => v.trim() !== '' || 'Required' },
        { type: 'number', name: 'port', message: 'SSH port:', default: 22 },
        { type: 'input', name: 'user', message: 'SSH user:', default: localUser },
        { type: 'input', name: 'keyPath', message: 'SSH private key path:', default: localKeyPath },
      ])
      localHost = localAnswers.host
      localPort = localAnswers.port
      localUser = localAnswers.user
      localKeyPath = localAnswers.keyPath
    }

    // ── Step 3: Stack basics ───────────────────────────────────────────────────
    const stackAnswers = await inquirer.prompt<{
      stackName: string; region: string; instanceSize: string;
      stateBucket: string; sshKeyPath: string; sshCidr: string; openclawVersion: string
    }>([
      {
        type: 'input',
        name: 'stackName',
        message: 'Stack name:',
        default: 'prod',
        validate: (v: string) => /^[a-z][a-z0-9-]{0,62}$/.test(v) || 'Lowercase letters, numbers, hyphens only',
      },
      ...(provider !== 'local' ? [
        {
          type: 'input',
          name: 'region',
          message: `Region (default: ${defaultRegion(provider)}):`,
          default: defaultRegion(provider),
        },
        {
          type: 'list',
          name: 'instanceSize',
          message: 'Instance size:',
          choices: instanceChoices(provider),
        },
        {
          type: 'input',
          name: 'stateBucket',
          message: `${stateLabel(provider)} bucket name for Pulumi state:`,
          validate: (v: string) => v.trim() !== '' || 'Required',
        },
        {
          type: 'input',
          name: 'sshKeyPath',
          message: 'SSH public key path:',
          default: `${process.env['HOME'] ?? '~'}/.ssh/id_rsa.pub`,
        },
        {
          type: 'input',
          name: 'sshCidr',
          message: 'Allowed SSH CIDR (your public IP/32 or 0.0.0.0/0 for open):',
          default: '0.0.0.0/0',
        },
      ] as InquirerQuestion[] : []),
      {
        type: 'input',
        name: 'openclawVersion',
        message: 'OpenClaw version:',
        default: 'stable',
      },
    ])

    // ── Step 4: LLM provider ───────────────────────────────────────────────────
    const { modelProviderId } = await inquirer.prompt<{ modelProviderId: string }>([{
      type: 'list',
      name: 'modelProviderId',
      message: 'Which LLM provider should OpenClaw use?',
      choices: catalogs.models.map((p) => ({ name: p.displayName, value: p.id })),
    }])

    const modelProvider = catalogs.models.find((p) => p.id === modelProviderId)!
    const modelConfig: Record<string, unknown> = {}
    const secrets: Array<{ name: string; source: 'env' | 'file'; ref: string }> = []

    // Model selection within provider
    const { selectedModelId } = await inquirer.prompt<{ selectedModelId: string }>([{
      type: 'list',
      name: 'selectedModelId',
      message: `Which ${modelProvider.displayName} model?`,
      choices: modelProvider.models.map((m) => ({
        name: m.family ? `[${m.family}] ${m.displayName}` : m.displayName,
        value: m.id,
      })),
      default: modelProvider.defaultModel,
    }])

    const selectedModel = modelProvider.models.find((m) => m.id === selectedModelId)!

    if (modelProvider.credentialSource === 'api-key') {
      // Ask how the key is stored
      const { secretSource } = await inquirer.prompt<{ secretSource: 'env' | 'file' }>([{
        type: 'list',
        name: 'secretSource',
        message: `How is your ${modelProvider.displayName} API key stored?`,
        choices: [
          { name: `Environment variable (${modelProvider.envDefault ?? 'API_KEY'})`, value: 'env' },
          { name: 'File path (e.g. ~/.secrets/api-key)', value: 'file' },
        ],
      }])

      if (secretSource === 'env') {
        const { envVar } = await inquirer.prompt<{ envVar: string }>([{
          type: 'input',
          name: 'envVar',
          message: 'Environment variable name:',
          default: modelProvider.envDefault ?? 'API_KEY',
        }])
        secrets.push({ name: `${modelProviderId.toUpperCase()}_API_KEY`, source: 'env', ref: envVar })
        modelConfig['apiKey'] = `$secret:${modelProviderId.toUpperCase()}_API_KEY`
      } else {
        const { filePath } = await inquirer.prompt<{ filePath: string }>([{
          type: 'input',
          name: 'filePath',
          message: 'File path to API key:',
        }])
        secrets.push({ name: `${modelProviderId.toUpperCase()}_API_KEY`, source: 'file', ref: filePath })
        modelConfig['apiKey'] = `$secret:${modelProviderId.toUpperCase()}_API_KEY`
      }
    } else if (modelProvider.credentialSource === 'aws-profile') {
      info(`\n${modelProvider.iamNote ?? 'Using AWS instance role for credentials.'}`)
    } else if (modelProvider.id === 'ollama') {
      const { baseUrl } = await inquirer.prompt<{ baseUrl: string }>([{
        type: 'input',
        name: 'baseUrl',
        message: 'Ollama base URL:',
        default: modelProvider.baseUrlDefault ?? 'http://localhost:11434',
      }])
      modelConfig['baseUrl'] = baseUrl
    }

    // Build the model config block
    const builtModelConfig: Record<string, unknown> = {
      provider: modelProviderId,
      ...(selectedModel.modelId ? { modelId: selectedModel.modelId } : { model: selectedModel.id }),
      ...modelConfig,
    }

    // ── Step 5: Integrations ───────────────────────────────────────────────────
    const { wantsIntegrations } = await inquirer.prompt<{ wantsIntegrations: boolean }>([{
      type: 'confirm',
      name: 'wantsIntegrations',
      message: 'Set up channel integrations (Discord, Telegram, Slack, etc.)?',
      default: false,
    }])

    const channelsConfig: Record<string, Record<string, unknown>> = {}
    const infraRequired: Integration[] = []

    if (wantsIntegrations) {
      const { selectedIntegrations } = await inquirer.prompt<{ selectedIntegrations: string[] }>([{
        type: 'checkbox',
        name: 'selectedIntegrations',
        message: 'Select integrations to enable:',
        choices: catalogs.integrations.map((i) => ({ name: `${i.displayName} — ${i.description}`, value: i.id })),
      }])

      for (const integId of selectedIntegrations) {
        const integ = catalogs.integrations.find((i) => i.id === integId)!
        const channelConfig: Record<string, unknown> = {}

        for (const field of integ.fields) {
          if (field.sensitive && field.envDefault) {
            const { secretSource } = await inquirer.prompt<{ secretSource: 'env' | 'file' }>([{
              type: 'list',
              name: 'secretSource',
              message: `${integ.displayName} — ${field.label}: how is this stored?`,
              choices: [
                { name: `Environment variable (${field.envDefault})`, value: 'env' },
                { name: 'File path', value: 'file' },
              ],
            }])

            const secretName = field.envDefault
            if (secretSource === 'env') {
              const { envVar } = await inquirer.prompt<{ envVar: string }>([{
                type: 'input', name: 'envVar', message: 'Environment variable name:', default: field.envDefault,
              }])
              secrets.push({ name: secretName, source: 'env', ref: envVar })
            } else {
              const { filePath } = await inquirer.prompt<{ filePath: string }>([{
                type: 'input', name: 'filePath', message: 'File path:', default: '',
              }])
              secrets.push({ name: secretName, source: 'file', ref: filePath })
            }
            channelConfig[field.name] = `$secret:${secretName}`
          } else {
            const { value } = await inquirer.prompt<{ value: string }>([{
              type: 'input',
              name: 'value',
              message: `${integ.displayName} — ${field.label}:`,
              default: '',
            }])
            channelConfig[field.name] = value
          }
        }

        channelsConfig[integ.channelKey] = channelConfig
        if (integ.infraRequired) infraRequired.push(integ)
      }
    }

    // ── Step 6: Build output ───────────────────────────────────────────────────
    const openclawConfigOverlay: Record<string, unknown> = {
      models: { provider: modelProviderId, ...builtModelConfig },
    }

    let outputPath: string

    if (provider === 'local') {
      // Local: generate a config overlay JSON (no deploy plan)
      if (Object.keys(channelsConfig).length > 0) {
        openclawConfigOverlay['channels'] = channelsConfig
      }

      outputPath = path.join(outDir, `openclaw-${stackAnswers.stackName}.json`)
      writeFileSync(outputPath, JSON.stringify(openclawConfigOverlay, null, 2), 'utf-8')

      process.stdout.write('\n')
      success(`Config overlay written to ${outputPath}`)
      info(`\nNext steps:`)
      info(`  1. Run: clawops init --provider local --host ${localHost} --port ${localPort} --user ${localUser} --key ${localKeyPath} --stack ${stackAnswers.stackName}`)
      info(`  2. Run: clawops up --stack ${stackAnswers.stackName} --config ${outputPath}`)
    } else {
      // Cloud: generate a full deploy plan
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
      success(`Deploy plan written to ${outputPath}`)
    }

    // ── Step 7: MCP setup snippet ──────────────────────────────────────────────
    process.stdout.write('\n')
    info('── MCP server setup ─────────────────────────────────────────────────')
    info('Add this to your Claude Desktop / Claude Code MCP config:\n')
    process.stdout.write(JSON.stringify({
      mcpServers: {
        clawops: { command: 'clawops', args: ['mcp', 'serve', '--read-only'] },
      },
    }, null, 2) + '\n')
    info('\nConfig file locations:')
    info('  macOS:  ~/Library/Application Support/Claude/claude_desktop_config.json')
    info('  Linux:  ~/.config/Claude/claude_desktop_config.json')
    info('  Claude Code: ~/.claude/claude_desktop_config.json')

    // ── Step 8: Post-setup notes ───────────────────────────────────────────────
    if (infraRequired.length > 0) {
      process.stdout.write('\n')
      info('── Webhook registration required ────────────────────────────────────')
      for (const integ of infraRequired) {
        info(`  ${integ.displayName}: ${integ.infraNote?.trim() ?? ''}`)
        if (integ.setupUrl) info(`  Setup: ${integ.setupUrl}`)
      }
    }

    if (modelProvider.id === 'ollama' && selectedModel.pullSuffix !== undefined) {
      process.stdout.write('\n')
      info('── Ollama model pull required ────────────────────────────────────────')
      info(`After deployment, SSH into the host and run:`)
      info(`  ollama pull ${selectedModel.id}${selectedModel.pullSuffix}`)
    }

    // ── Step 9: Apply now? ─────────────────────────────────────────────────────
    if (!dryRun && provider !== 'local') {
      const { applyNow } = await inquirer.prompt<{ applyNow: boolean }>([{
        type: 'confirm',
        name: 'applyNow',
        message: `Apply the plan now? (runs: clawops apply ${outputPath})`,
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
          success('Stack deployed successfully.')
          info(`Run: clawops doctor --stack ${stackAnswers.stackName} to verify`)
        } catch (err) {
          failure(err instanceof Error ? err.message : String(err))
          process.exit(1)
        }
      } else {
        info(`\nWhen ready: clawops apply ${outputPath}`)
      }
    }
  },
})

// ── Helpers ───────────────────────────────────────────────────────────────────

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
      { name: 'micro  — t3.micro   (~$8/mo)',  value: 'micro' },
      { name: 'small  — t3.small   (~$17/mo)', value: 'small' },
      { name: 'medium — t3.medium  (~$33/mo)', value: 'medium' },
      { name: 'large  — t3.large   (~$67/mo)', value: 'large' },
    ],
    gcp: [
      { name: 'micro  — e2-micro          (~$7/mo)',  value: 'micro' },
      { name: 'small  — e2-standard-2     (~$49/mo)', value: 'small' },
      { name: 'medium — e2-standard-4     (~$97/mo)', value: 'medium' },
      { name: 'large  — e2-standard-8     (~$194/mo)', value: 'large' },
    ],
    azure: [
      { name: 'micro  — Standard_B1s  (~$8/mo)',  value: 'micro' },
      { name: 'small  — Standard_B2s  (~$35/mo)', value: 'small' },
      { name: 'medium — Standard_B4ms (~$70/mo)', value: 'medium' },
      { name: 'large  — Standard_B8ms (~$140/mo)', value: 'large' },
    ],
  }
  return table[provider] ?? []
}
