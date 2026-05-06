// Local provider adapter unit tests.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import localAdapter from '../../../src/providers/local/index.js'
import process from 'node:process'

describe('localAdapter.name', () => {
  it('is "local"', () => {
    expect(localAdapter.name).toBe('local')
  })
})

describe('localAdapter.normalizeInstanceType()', () => {
  it('always returns "local"', () => {
    expect(localAdapter.normalizeInstanceType('micro')).toBe('local')
    expect(localAdapter.normalizeInstanceType('large')).toBe('local')
  })
})

describe('localAdapter.defaultRegion()', () => {
  it('returns "local"', () => {
    expect(localAdapter.defaultRegion()).toBe('local')
  })
})

describe('localAdapter.stateBackendUrl()', () => {
  it('returns file:// URL ignoring the bucket argument', () => {
    expect(localAdapter.stateBackendUrl('irrelevant')).toBe('file://~/.clawops/state')
  })
})

describe('localAdapter.getConnectionInfo()', () => {
  it('maps stack outputs to ConnectionInfo', () => {
    const outputs = {
      instanceId: 'local:10.0.0.1',
      publicIp: '10.0.0.1',
      gatewayUrl: 'http://10.0.0.1:18789',
      sshHost: '10.0.0.1',
      sshPort: 2222,
      sshUser: 'ubuntu',
      region: 'local',
      provisionedAt: '2026-05-06T00:00:00.000Z',
      privateKeyPath: '/home/user/.clawops/id_ed25519',
      knownHostsPath: '/home/user/.clawops/known_hosts',
    }
    const conn = localAdapter.getConnectionInfo(outputs)
    expect(conn.host).toBe('10.0.0.1')
    expect(conn.port).toBe(2222)
    expect(conn.user).toBe('ubuntu')
    expect(conn.privateKeyPath).toBe('/home/user/.clawops/id_ed25519')
    expect(conn.knownHostsPath).toBe('/home/user/.clawops/known_hosts')
  })

  it('defaults port to 22 and user to root when fields are absent', () => {
    // ?? only triggers on null/undefined, so omit the keys entirely
    const outputs = {
      instanceId: '',
      publicIp: '1.2.3.4',
      gatewayUrl: '',
      sshHost: '1.2.3.4',
      region: 'local',
      provisionedAt: '',
    } as unknown as Parameters<typeof localAdapter.getConnectionInfo>[0]
    const conn = localAdapter.getConnectionInfo(outputs)
    expect(conn.port).toBe(22)
    expect(conn.user).toBe('root')
  })
})

describe('localAdapter.validateConfig()', () => {
  let savedEnv: string | undefined

  beforeEach(() => {
    savedEnv = process.env['CLAWOPS_SSH_KEY_PATH']
    delete process.env['CLAWOPS_SSH_KEY_PATH']
  })

  afterEach(() => {
    if (savedEnv !== undefined) {
      process.env['CLAWOPS_SSH_KEY_PATH'] = savedEnv
    } else {
      delete process.env['CLAWOPS_SSH_KEY_PATH']
    }
  })

  it('returns ok when CLAWOPS_SSH_KEY_PATH is not set', async () => {
    const result = await localAdapter.validateConfig()
    expect(result.ok).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('returns ok when CLAWOPS_SSH_KEY_PATH points to a readable file', async () => {
    // Use an existing file that we know exists
    process.env['CLAWOPS_SSH_KEY_PATH'] = '/etc/hosts'
    const result = await localAdapter.validateConfig()
    expect(result.ok).toBe(true)
  })

  it('returns error when CLAWOPS_SSH_KEY_PATH points to a missing file', async () => {
    process.env['CLAWOPS_SSH_KEY_PATH'] = '/nonexistent/path/id_ed25519'
    const result = await localAdapter.validateConfig()
    expect(result.ok).toBe(false)
    expect(result.errors[0]).toMatch(/SSH key not readable/)
  })
})
