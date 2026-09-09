// Provider plugins: which a config needs, and whether they loaded.
//
// The failure this guards against is quiet. Measured on 2026.9.2: with egress the gateway
// installs a missing provider plugin mid-boot and exits 1 for a convergence restart; with
// egress denied it starts HEALTHY and simply lacks the provider. clawops defaults to
// deny-all egress, so the silent case is the default one.

import { describe, it, expect } from 'vitest'
import { requiredPlugins, installCommand, missingProviders } from '../../src/openclaw/plugins.js'

const CATALOG = {
  providers: [
    { id: 'openai', configPath: 'models.providers.openai' },
    { id: 'ollama', configPath: 'models.providers.ollama' },
    { id: 'deepseek', configPath: 'models.providers.deepseek',
      plugin: { package: '@openclaw/deepseek-provider', version: '2026.9.2' } },
    { id: 'bedrock', configPath: 'models.providers.amazon-bedrock',
      plugin: { package: '@openclaw/amazon-bedrock-provider', version: '2026.9.2' } },
  ],
}

describe('requiredPlugins', () => {
  it('asks for nothing when every configured provider is bundled', () => {
    const cfg = { models: { providers: { openai: {}, ollama: {} } } }
    expect(requiredPlugins(cfg, CATALOG)).toEqual([])
  })

  it('resolves the provider id OpenClaw uses, not the catalog id', () => {
    // The catalog calls it "bedrock"; OpenClaw calls it "amazon-bedrock". Matching on the
    // catalog id would silently install nothing for a Bedrock deployment.
    const cfg = { models: { providers: { 'amazon-bedrock': {} } } }
    const r = requiredPlugins(cfg, CATALOG)
    expect(r).toHaveLength(1)
    expect(r[0]!.providerId).toBe('amazon-bedrock')
    expect(r[0]!.package).toBe('@openclaw/amazon-bedrock-provider')
  })

  it('ignores providers the config does not name', () => {
    const cfg = { models: { providers: { deepseek: {} } } }
    expect(requiredPlugins(cfg, CATALOG).map((p) => p.providerId)).toEqual(['deepseek'])
  })

  it('survives a config with no models section', () => {
    for (const cfg of [{}, { models: {} }, { models: { providers: {} } }, null, 'nope']) {
      expect(requiredPlugins(cfg, CATALOG)).toEqual([])
    }
  })
})

describe('installCommand', () => {
  it('pins the version and accepts capabilities', () => {
    const cmd = installCommand(
      { providerId: 'amazon-bedrock', package: '@openclaw/amazon-bedrock-provider', version: '2026.9.2' },
      'ghcr.io/openclaw/openclaw:2026.9.2',
      '/var/lib/clawops/openclaw',
    )
    // Pinned, not `latest`: these packages moved 2026.9.2 -> 2026.9.3 within hours on
    // 2026-09-08, and the newer builds require a runtime newer than the supported floor.
    // Installing `latest` would mean a plan that deployed this morning fails this afternoon.
    expect(cmd).toContain('@openclaw/amazon-bedrock-provider@2026.9.2')
    expect(cmd).not.toContain('latest')
    // Provisioning has no terminal to answer a capabilities prompt on.
    expect(cmd).toContain('--accept-capabilities')
    // Installs into the state directory, so it survives container replacement.
    expect(cmd).toContain('/var/lib/clawops/openclaw:/home/node/.openclaw')
  })
})

describe('missingProviders', () => {
  const listed = (plugins: unknown[]) => JSON.stringify({ plugins })

  it('reports a configured provider that did not load', () => {
    const cfg = { models: { providers: { 'amazon-bedrock': {}, openai: {} } } }
    const out = listed([{ id: 'openai', enabled: true, status: 'loaded', providerIds: ['openai'] }])
    expect(missingProviders(cfg, out)).toEqual(['amazon-bedrock'])
  })

  it('reports nothing when everything loaded', () => {
    const cfg = { models: { providers: { openai: {} } } }
    const out = listed([{ id: 'openai', enabled: true, status: 'loaded', providerIds: ['openai'] }])
    expect(missingProviders(cfg, out)).toEqual([])
  })

  it('matches on providerIds, not plugin id', () => {
    // The `google` plugin serves google, google-gemini-cli and google-vertex. Comparing
    // plugin ids would report google-vertex as missing on a working deployment.
    const cfg = { models: { providers: { 'google-vertex': {} } } }
    const out = listed([
      { id: 'google', enabled: true, status: 'loaded',
        providerIds: ['google', 'google-gemini-cli', 'google-vertex'] },
    ])
    expect(missingProviders(cfg, out)).toEqual([])
  })

  it('does not count a disabled or errored plugin as loaded', () => {
    const cfg = { models: { providers: { deepseek: {} } } }
    expect(missingProviders(cfg, listed([{ id: 'deepseek', enabled: false, providerIds: ['deepseek'] }])))
      .toEqual(['deepseek'])
    expect(missingProviders(cfg, listed([{ id: 'deepseek', status: 'error', providerIds: ['deepseek'] }])))
      .toEqual(['deepseek'])
  })

  it('stays quiet when the plugin list is unreadable', () => {
    // An unparseable listing is a reporting failure. Claiming every provider is missing
    // would turn it into a false alarm on a healthy deployment.
    const cfg = { models: { providers: { openai: {} } } }
    expect(missingProviders(cfg, 'not json')).toEqual([])
  })
})

describe('the shipped catalog', () => {
  it('pins a version for every provider that needs a plugin', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const yaml = await import('js-yaml')
    const catalog = yaml.load(
      readFileSync(resolve(import.meta.dirname, '../../spec/models.yaml'), 'utf8'),
    ) as { providers: Array<{ id: string; plugin?: { package: string; version: string } }> }

    const withPlugin = catalog.providers.filter((p) => p.plugin)
    expect(withPlugin.length, 'expected non-bundled providers in the catalog').toBeGreaterThan(0)
    for (const p of withPlugin) {
      expect(p.plugin!.package, p.id).toMatch(/^@openclaw\//)
      expect(p.plugin!.version, `${p.id} must pin a version, never track latest`).toMatch(/^\d/)
    }
  })
})
