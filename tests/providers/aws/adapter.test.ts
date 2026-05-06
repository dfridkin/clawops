// AWS provider adapter unit tests.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import awsAdapter from '../../../src/providers/aws/index.js'
import process from 'node:process'

describe('awsAdapter.normalizeInstanceType()', () => {
  it.each([
    ['micro',  't3.micro'],
    ['small',  't3.small'],
    ['medium', 't3.medium'],
    ['large',  't3.large'],
    ['gpu',    'g4dn.xlarge'],
  ] as const)('%s → %s', (alias, expected) => {
    expect(awsAdapter.normalizeInstanceType(alias)).toBe(expected)
  })
})

describe('awsAdapter.defaultRegion()', () => {
  it('returns us-east-1', () => {
    expect(awsAdapter.defaultRegion()).toBe('us-east-1')
  })
})

describe('awsAdapter.stateBackendUrl()', () => {
  it('formats s3:// URL', () => {
    expect(awsAdapter.stateBackendUrl('my-bucket')).toBe('s3://my-bucket')
  })
})

describe('awsAdapter.name', () => {
  it('is "aws"', () => {
    expect(awsAdapter.name).toBe('aws')
  })
})

describe('awsAdapter.getConnectionInfo()', () => {
  it('extracts connection fields with sshUser=ubuntu', () => {
    const outputs = {
      instanceId: 'i-1234',
      publicIp: '5.6.7.8',
      gatewayUrl: 'https://5.6.7.8:18789',
      sshHost: '5.6.7.8',
      sshPort: 22,
      sshUser: 'ubuntu',
      region: 'us-east-1',
      provisionedAt: '2026-01-01T00:00:00.000Z',
      privateKeyPath: '/home/.clawops/id_ed25519',
      knownHostsPath: '/home/.clawops/known_hosts',
    }
    const conn = awsAdapter.getConnectionInfo(outputs)
    expect(conn.host).toBe('5.6.7.8')
    expect(conn.port).toBe(22)
    expect(conn.user).toBe('ubuntu')
    expect(conn.privateKeyPath).toBe('/home/.clawops/id_ed25519')
  })
})

describe('awsAdapter.validateConfig()', () => {
  const envVars = ['AWS_PROFILE', 'AWS_ACCESS_KEY_ID', 'AWS_ROLE_ARN', 'AWS_WEB_IDENTITY_TOKEN_FILE']
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

  it('returns ok:true when AWS_PROFILE is set', async () => {
    process.env['AWS_PROFILE'] = 'default'
    const result = await awsAdapter.validateConfig()
    expect(result.ok).toBe(true)
  })

  it('returns ok:true when AWS_ACCESS_KEY_ID is set', async () => {
    process.env['AWS_ACCESS_KEY_ID'] = 'AKIAIOSFODNN7EXAMPLE'
    const result = await awsAdapter.validateConfig()
    expect(result.ok).toBe(true)
  })

  it('returns ok:true when OIDC env vars are set', async () => {
    process.env['AWS_ROLE_ARN'] = 'arn:aws:iam::123456789012:role/deploy'
    process.env['AWS_WEB_IDENTITY_TOKEN_FILE'] = '/var/run/secrets/token'
    const result = await awsAdapter.validateConfig()
    expect(result.ok).toBe(true)
  })

  it('returns ok:false when no credentials and IMDS is unreachable', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))
    try {
      const result = await awsAdapter.validateConfig()
      expect(result.ok).toBe(false)
      expect(result.errors[0]).toContain('AWS_PROFILE')
    } finally {
      fetchSpy.mockRestore()
    }
  })
})
