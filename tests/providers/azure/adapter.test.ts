// Azure provider adapter unit tests.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import azureAdapter from '../../../src/providers/azure/index.js'
import process from 'node:process'

describe('azureAdapter.normalizeInstanceType()', () => {
  it.each([
    ['micro',  'Standard_B1s'],
    ['small',  'Standard_B2s'],
    ['medium', 'Standard_B4ms'],
    ['large',  'Standard_B8ms'],
    ['gpu',    'Standard_NC6s_v3'],
  ] as const)('%s → %s', (alias, expected) => {
    expect(azureAdapter.normalizeInstanceType(alias)).toBe(expected)
  })
})

describe('azureAdapter.defaultRegion()', () => {
  it('returns eastus', () => {
    expect(azureAdapter.defaultRegion()).toBe('eastus')
  })
})

describe('azureAdapter.stateBackendUrl()', () => {
  it('formats azblob:// URL', () => {
    expect(azureAdapter.stateBackendUrl('my-container')).toBe('azblob://my-container')
  })
})

describe('azureAdapter.name', () => {
  it('is "azure"', () => {
    expect(azureAdapter.name).toBe('azure')
  })
})

describe('azureAdapter.getConnectionInfo()', () => {
  it('extracts connection fields with sshUser=clawops', () => {
    const outputs = {
      instanceId: 'vm-id-123',
      publicIp: '5.6.7.8',
      gatewayUrl: 'https://5.6.7.8:18789',
      sshHost: '5.6.7.8',
      sshPort: 22,
      sshUser: 'clawops',
      region: 'eastus',
      provisionedAt: '2026-01-01T00:00:00.000Z',
      privateKeyPath: '/home/.clawops/id_ed25519',
      knownHostsPath: '/home/.clawops/known_hosts',
    }
    const conn = azureAdapter.getConnectionInfo(outputs)
    expect(conn.host).toBe('5.6.7.8')
    expect(conn.port).toBe(22)
    expect(conn.user).toBe('clawops')
    expect(conn.privateKeyPath).toBe('/home/.clawops/id_ed25519')
  })
})

describe('azureAdapter.validateConfig()', () => {
  const envVars = [
    'AZURE_CLIENT_ID',
    'AZURE_TENANT_ID',
    'AZURE_CLIENT_SECRET',
    'AZURE_FEDERATED_TOKEN_FILE',
    'AZURE_CONFIG_DIR',
  ]
  let saved: Record<string, string | undefined> = {}
  let cliDir: string

  beforeEach(() => {
    saved = Object.fromEntries(envVars.map(k => [k, process.env[k]]))
    envVars.forEach(k => delete process.env[k])
    // An empty config dir, so "no credentials" does not depend on whether whoever runs this
    // happens to have done `az login`. Two suites passed locally and failed in CI today for
    // exactly that reason.
    cliDir = mkdtempSync(path.join(tmpdir(), 'azure-empty-'))
    process.env['AZURE_CONFIG_DIR'] = cliDir
  })

  afterEach(() => {
    envVars.forEach(k => {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    })
    rmSync(cliDir, { recursive: true, force: true })
  })

  /** What `az login` leaves on disk. */
  function writeCliLogin() {
    writeFileSync(
      path.join(cliDir, 'azureProfile.json'),
      JSON.stringify({ subscriptions: [{ id: 'sub-1', name: 'Pay-As-You-Go', isDefault: true }] }),
    )
  }

  it('returns ok:true when service principal env vars are set', async () => {
    process.env['AZURE_CLIENT_ID'] = 'client-123'
    process.env['AZURE_TENANT_ID'] = 'tenant-456'
    process.env['AZURE_CLIENT_SECRET'] = 'secret-abc'
    const result = await azureAdapter.validateConfig()
    expect(result.ok).toBe(true)
  })

  it('returns ok:true when OIDC federated token env vars are set', async () => {
    process.env['AZURE_CLIENT_ID'] = 'client-123'
    process.env['AZURE_TENANT_ID'] = 'tenant-456'
    process.env['AZURE_FEDERATED_TOKEN_FILE'] = '/var/run/secrets/token'
    const result = await azureAdapter.validateConfig()
    expect(result.ok).toBe(true)
  })

  it('returns ok:false when no credentials and IMDS is unreachable', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))
    try {
      const result = await azureAdapter.validateConfig()
      expect(result.ok).toBe(false)
      expect(result.errors[0]).toContain('AZURE_CLIENT_ID')
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('accepts an `az login`, which is a credential Pulumi will use', async () => {
    // azure-native falls back to the Azure CLI when no service principal is set, so refusing
    // this turned away a credential clawops was about to rely on.
    writeCliLogin()
    const result = await azureAdapter.validateConfig()
    expect(result.ok).toBe(true)
  })

  it('still refuses when the CLI profile has no subscriptions', async () => {
    // What `az logout` leaves behind.
    writeFileSync(path.join(cliDir, 'azureProfile.json'), JSON.stringify({ subscriptions: [] }))
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))
    try {
      expect((await azureAdapter.validateConfig()).ok).toBe(false)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('names `az login` first in the error, as the thing most people will do', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))
    try {
      const result = await azureAdapter.validateConfig()
      expect(result.errors[0]).toMatch(/Run `az login`/)
    } finally {
      fetchSpy.mockRestore()
    }
  })
})

describe('azureAdapter.preflight()', () => {
  const VARS = ['ARM_SUBSCRIPTION_ID', 'AZURE_SUBSCRIPTION_ID', 'AZURE_CONFIG_DIR'] as const
  const kept: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const v of VARS) {
      kept[v] = process.env[v]
      delete process.env[v]
    }
    process.env['AZURE_CONFIG_DIR'] = '/nonexistent-azure-config'
  })
  afterEach(() => {
    for (const v of VARS) {
      if (kept[v] === undefined) delete process.env[v]
      else process.env[v] = kept[v]
    }
  })

  it('delegates to the preflight checks', async () => {
    // The checks themselves are covered in preflight.test.ts, which calls them directly — so
    // without this the adapter could stop calling them at all and nothing would notice.
    const checks = await azureAdapter.preflight!({})
    expect(checks).toHaveLength(1)
    expect(checks[0]?.id).toBe('subscription-resolved')
    expect(checks[0]?.ok).toBe(false)
  })

  it('passes the caller\'s options through', async () => {
    process.env['ARM_SUBSCRIPTION_ID'] = 'sub-from-env'
    process.env['AZURE_STORAGE_ACCOUNT'] = 'acct'
    process.env['AZURE_STORAGE_KEY'] = 'key'
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 500 }),
    )
    try {
      const checks = await azureAdapter.preflight!({ bucket: 'clawops-state' })
      expect(checks.find((c) => c.id === 'state-backend-credentials')?.detail).toContain(
        'azblob://clawops-state',
      )
    } finally {
      spy.mockRestore()
      delete process.env['AZURE_STORAGE_ACCOUNT']
      delete process.env['AZURE_STORAGE_KEY']
    }
  })
})
