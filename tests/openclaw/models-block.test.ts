import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { buildModelsBlock, providerKeyOf, type CatalogProvider } from '../../src/openclaw/models.js'
import { validateConfig } from '../../src/openclaw/config-validate.js'

// The wizard wrote `models: { provider, modelId }` for five releases. That is not a shape
// OpenClaw has — validation rejects it for EVERY provider — and because `requiredPlugins`
// reads `models.providers`, the wrong key also meant no plugin was ever installed for the
// provider the operator chose. On Bedrock that exits the gateway 78.

const catalog = yaml.load(
  readFileSync(path.join(process.cwd(), 'spec/models.yaml'), 'utf-8'),
) as { providers: Array<CatalogProvider & { models: Array<{ id: string; modelId?: string; displayName: string }> }> }

const each = catalog.providers.map((p) => [p.id, p] as const)

describe('providerKeyOf', () => {
  it('uses OpenClaw’s provider id, not the catalog id', () => {
    // `bedrock` in the catalog is `amazon-bedrock` to OpenClaw, and the plugin advertises
    // providerIds: ["amazon-bedrock"]. Keying by catalog id writes a block nothing reads.
    const bedrock = catalog.providers.find((p) => p.id === 'bedrock')!
    expect(providerKeyOf(bedrock)).toBe('amazon-bedrock')
  })

  it('falls back to the id when no configPath is declared', () => {
    expect(providerKeyOf({ id: 'custom' })).toBe('custom')
  })
})

describe('buildModelsBlock', () => {
  it.each(each)('%s produces a config OpenClaw accepts', async (_id, provider) => {
    const model = provider.models[0]!
    const block = buildModelsBlock({
      provider,
      model,
      resolvedModelId: provider.id === 'bedrock' ? `us.${model.modelId}` : undefined,
      apiKeyRef: provider.credentialSource === 'api-key' ? '$secret:KEY' : undefined,
      baseUrl: provider.id === 'ollama' ? 'http://host.docker.internal:11434' : undefined,
      region: provider.credentialSource === 'aws-profile' ? 'us-east-1' : undefined,
    })

    const { errors } = await validateConfig(
      {
        meta: { lastTouchedVersion: '2026.9.2' },
        gateway: { mode: 'local', port: 18789, auth: { mode: 'token' } },
        models: block,
        channels: {},
      },
      { schemaCapturedFrom: '2026.9.2' },
    )
    expect(errors, `${provider.id} config rejected`).toEqual([])
  })

  it.each(each)('%s is keyed under models.providers', (_id, provider) => {
    const block = buildModelsBlock({ provider, model: provider.models[0]! })
    expect(Object.keys(block)).toEqual(['providers'])
    expect(Object.keys(block['providers'] as object)).toEqual([providerKeyOf(provider)])
  })

  it.each(each)('%s always declares at least one model', (_id, provider) => {
    // Without a models[] array the provider contributes nothing to `openclaw models list`,
    // so there is no model to select and the deployment has no backend.
    const block = buildModelsBlock({ provider, model: provider.models[0]! })
    const entry = (block['providers'] as Record<string, { models?: unknown[] }>)[providerKeyOf(provider)]!
    expect(entry.models).toHaveLength(1)
  })

  it('never emits the shape the wizard used to write', () => {
    const provider = catalog.providers[0]!
    const block = buildModelsBlock({ provider, model: provider.models[0]! })
    expect(block).not.toHaveProperty('provider')
    expect(block).not.toHaveProperty('modelId')
  })

  it('sets the transport for Bedrock, on the provider and the model', () => {
    // Without it the call routes through the OpenAI-compatible transport and fails with
    // "requires an explicit base URL before using an OpenAI-compatible API".
    const bedrock = catalog.providers.find((p) => p.id === 'bedrock')!
    const block = buildModelsBlock({ provider: bedrock, model: bedrock.models[0]!, region: 'us-east-1' })
    const entry = (block['providers'] as Record<string, { api?: string; models: Array<{ api?: string }> }>)['amazon-bedrock']!
    expect(entry.api).toBe('bedrock-converse-stream')
    expect(entry.models[0]!.api).toBe('bedrock-converse-stream')
  })

  it('sets no transport for a bundled provider, which resolves its own', () => {
    // Measured: `anthropic` selects api=anthropic-messages with nothing in the config.
    // Writing a value here would override a correct default with a guess.
    const anthropic = catalog.providers.find((p) => p.id === 'anthropic')!
    const block = buildModelsBlock({ provider: anthropic, model: anthropic.models[0]!, apiKeyRef: '$secret:K' })
    const entry = (block['providers'] as Record<string, { api?: string }>)['anthropic']!
    expect(entry.api).toBeUndefined()
  })

  it('prefers a resolved model id over the catalog one', () => {
    const bedrock = catalog.providers.find((p) => p.id === 'bedrock')!
    const block = buildModelsBlock({
      provider: bedrock, model: bedrock.models[0]!, resolvedModelId: 'us.some.profile', region: 'us-east-1',
    })
    const entry = (block['providers'] as Record<string, { models: Array<{ id: string }> }>)['amazon-bedrock']!
    expect(entry.models[0]!.id).toBe('us.some.profile')
  })
})
