import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}))

import { execSync } from 'node:child_process'
import { resolveCredentials, applyCredentials, profileExists } from '../../src/config/profiles.js'
import type { CredentialsRef } from '../../src/config/store.js'

const mockExecSync = vi.mocked(execSync)

describe('resolveCredentials()', () => {
  beforeEach(() => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'test-key')
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'test-secret')
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', '/tmp/adc.json')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('env source: returns declared env vars', () => {
    const ref: CredentialsRef = {
      source: 'env',
      envVars: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],
    }
    const result = resolveCredentials(ref)
    expect(result['AWS_ACCESS_KEY_ID']).toBe('test-key')
    expect(result['AWS_SECRET_ACCESS_KEY']).toBe('test-secret')
  })

  it('env source: throws when required env var is missing', () => {
    vi.unstubAllEnvs()
    const ref: CredentialsRef = { source: 'env', envVars: ['MISSING_VAR'] }
    expect(() => resolveCredentials(ref)).toThrow(/MISSING_VAR/)
  })

  it('cli-profile source: returns AWS_PROFILE', () => {
    const ref: CredentialsRef = { source: 'cli-profile', profileName: 'production' }
    const result = resolveCredentials(ref)
    expect(result['AWS_PROFILE']).toBe('production')
  })

  it('cli-profile source: returns empty object when profileName is absent', () => {
    const ref: CredentialsRef = { source: 'cli-profile' }
    expect(resolveCredentials(ref)).toEqual({})
  })

  it('file source: returns GOOGLE_APPLICATION_CREDENTIALS when set', () => {
    const ref: CredentialsRef = { source: 'file' }
    const result = resolveCredentials(ref)
    expect(result['GOOGLE_APPLICATION_CREDENTIALS']).toBe('/tmp/adc.json')
  })

  it('instance-metadata source: returns empty object', () => {
    const ref: CredentialsRef = { source: 'instance-metadata' }
    expect(resolveCredentials(ref)).toEqual({})
  })
})

describe('applyCredentials()', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    delete process.env['AWS_PROFILE']
  })

  it('sets env vars in process.env', () => {
    const ref: CredentialsRef = { source: 'cli-profile', profileName: 'staging' }
    applyCredentials(ref)
    expect(process.env['AWS_PROFILE']).toBe('staging')
  })
})

describe('profileExists()', () => {
  it('returns true when profile name appears in aws output', () => {
    mockExecSync.mockReturnValue('default\nproduction\nstaging\n')
    expect(profileExists('production')).toBe(true)
  })

  it('returns false when profile is not in aws output', () => {
    mockExecSync.mockReturnValue('default\n')
    expect(profileExists('nonexistent')).toBe(false)
  })

  it('returns false when execSync throws (aws CLI not found)', () => {
    mockExecSync.mockImplementation(() => { throw new Error('command not found') })
    expect(profileExists('any')).toBe(false)
  })
})
