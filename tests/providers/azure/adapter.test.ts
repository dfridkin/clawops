// Azure provider adapter unit tests.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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
  ]
  let saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    saved = Object.fromEntries(envVars.map(k => [k, process.env[k]]))
    envVars.forEach(k => delete process.env[k])
  })

  afterEach(() => {
    envVars.forEach(k => {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    })
  })

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
})
