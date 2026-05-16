// GCP provider adapter unit tests.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import gcpAdapter from '../../../src/providers/gcp/index.js'
import process from 'node:process'

describe('gcpAdapter.normalizeInstanceType()', () => {
  it.each([
    ['micro', 'e2-micro'],
    ['small', 'e2-standard-2'],
    ['medium', 'e2-standard-4'],
    ['large', 'e2-standard-8'],
  ] as const)('%s → %s', (alias, expected) => {
    expect(gcpAdapter.normalizeInstanceType(alias)).toBe(expected)
  })

  it('throws a clear error for gpu (not yet supported on GCP)', () => {
    expect(() => gcpAdapter.normalizeInstanceType('gpu')).toThrow('GPU instances are not yet supported on GCP')
  })
})

describe('gcpAdapter.defaultRegion()', () => {
  it('returns us-central1', () => {
    expect(gcpAdapter.defaultRegion()).toBe('us-central1')
  })
})

describe('gcpAdapter.stateBackendUrl()', () => {
  it('formats gs:// URL', () => {
    expect(gcpAdapter.stateBackendUrl('my-bucket')).toBe('gs://my-bucket')
  })
})

describe('gcpAdapter.name', () => {
  it('is "gcp"', () => {
    expect(gcpAdapter.name).toBe('gcp')
  })
})

describe('gcpAdapter.getConnectionInfo()', () => {
  it('extracts connection fields from stack outputs', () => {
    const outputs = {
      instanceId: 'inst-1',
      publicIp: '1.2.3.4',
      gatewayUrl: 'https://1.2.3.4:18789',
      sshHost: '1.2.3.4',
      sshPort: 22,
      sshUser: 'clawops',
      region: 'us-central1',
      provisionedAt: '2026-01-01T00:00:00.000Z',
      privateKeyPath: '/home/.clawops/id_ed25519',
      knownHostsPath: '/home/.clawops/known_hosts',
    }
    const conn = gcpAdapter.getConnectionInfo(outputs)
    expect(conn.host).toBe('1.2.3.4')
    expect(conn.port).toBe(22)
    expect(conn.user).toBe('clawops')
    expect(conn.privateKeyPath).toBe('/home/.clawops/id_ed25519')
  })
})

describe('gcpAdapter.validateConfig()', () => {
  const envVars = ['GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_OAUTH_ACCESS_TOKEN']
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

  it('returns ok:true when GOOGLE_APPLICATION_CREDENTIALS is set', async () => {
    process.env['GOOGLE_APPLICATION_CREDENTIALS'] = '/path/to/key.json'
    const result = await gcpAdapter.validateConfig()
    expect(result.ok).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('returns ok:true when GOOGLE_OAUTH_ACCESS_TOKEN is set', async () => {
    process.env['GOOGLE_OAUTH_ACCESS_TOKEN'] = 'ya29.some-token'
    const result = await gcpAdapter.validateConfig()
    expect(result.ok).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('returns ok:false with error message when no credentials and no ADC file', async () => {
    // Mock fs.accessSync to throw (ADC file absent) and fetch to reject (not on GCP)
    vi.mock('node:fs', async (importOriginal) => {
      const orig = await importOriginal<typeof import('node:fs')>()
      return { ...orig, accessSync: vi.fn().mockImplementation(() => { throw new Error('ENOENT') }) }
    })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))

    try {
      const result = await gcpAdapter.validateConfig()
      expect(result.ok).toBe(false)
      expect(result.errors[0]).toContain('GOOGLE_APPLICATION_CREDENTIALS')
    } finally {
      fetchSpy.mockRestore()
      vi.unmock('node:fs')
    }
  })
})
