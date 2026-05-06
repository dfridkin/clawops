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
    ['gpu', 'n1-standard-4'],
  ] as const)('%s → %s', (alias, expected) => {
    expect(gcpAdapter.normalizeInstanceType(alias)).toBe(expected)
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
  let prevCred: string | undefined

  beforeEach(() => {
    prevCred = process.env['GOOGLE_APPLICATION_CREDENTIALS']
  })

  afterEach(() => {
    if (prevCred === undefined) delete process.env['GOOGLE_APPLICATION_CREDENTIALS']
    else process.env['GOOGLE_APPLICATION_CREDENTIALS'] = prevCred
  })

  it('returns ok:true when GOOGLE_APPLICATION_CREDENTIALS is set', async () => {
    process.env['GOOGLE_APPLICATION_CREDENTIALS'] = '/path/to/key.json'
    const result = await gcpAdapter.validateConfig()
    expect(result.ok).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('returns ok:false with error message when no credentials', async () => {
    delete process.env['GOOGLE_APPLICATION_CREDENTIALS']
    delete process.env['CLOUDSDK_AUTH_ACCESS_TOKEN']

    // Mock the metadata server check to return false (not on GCP)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))

    try {
      const result = await gcpAdapter.validateConfig()
      expect(result.ok).toBe(false)
      expect(result.errors[0]).toContain('GOOGLE_APPLICATION_CREDENTIALS')
    } finally {
      fetchSpy.mockRestore()
    }
  })
})
