// Unit tests for extractBaseOutputs().

import { describe, it, expect } from 'vitest'
import { extractBaseOutputs } from '../../src/pulumi/outputs.js'
import { StateError } from '../../src/errors/index.js'

const FULL_OUTPUTS = {
  instanceId: 'i-abc123',
  publicIp: '1.2.3.4',
  gatewayUrl: 'https://1.2.3.4:18789',
  sshHost: '1.2.3.4',
  sshPort: 22,
  sshUser: 'clawops',
  region: 'us-central1',
  provisionedAt: '2026-05-06T00:00:00.000Z',
}

describe('extractBaseOutputs()', () => {
  it('returns typed BaseStackOutputs when all fields are present', () => {
    const result = extractBaseOutputs(FULL_OUTPUTS)
    expect(result.instanceId).toBe('i-abc123')
    expect(result.publicIp).toBe('1.2.3.4')
    expect(result.gatewayUrl).toBe('https://1.2.3.4:18789')
    expect(result.sshHost).toBe('1.2.3.4')
    expect(result.sshPort).toBe(22)
    expect(result.sshUser).toBe('clawops')
    expect(result.region).toBe('us-central1')
    expect(result.provisionedAt).toBe('2026-05-06T00:00:00.000Z')
  })

  it('coerces sshPort from string to number', () => {
    const result = extractBaseOutputs({ ...FULL_OUTPUTS, sshPort: '2222' })
    expect(result.sshPort).toBe(2222)
    expect(typeof result.sshPort).toBe('number')
  })

  const REQUIRED_FIELDS = [
    'instanceId',
    'publicIp',
    'gatewayUrl',
    'sshHost',
    'sshPort',
    'sshUser',
    'region',
    'provisionedAt',
  ] as const

  for (const field of REQUIRED_FIELDS) {
    it(`throws StateError when "${field}" is missing`, () => {
      const inputs = { ...FULL_OUTPUTS, [field]: undefined }
      expect(() => extractBaseOutputs(inputs)).toThrow(StateError)
      expect(() => extractBaseOutputs(inputs)).toThrow(field)
    })
  }

  it('throws StateError when a field is null', () => {
    expect(() => extractBaseOutputs({ ...FULL_OUTPUTS, publicIp: null })).toThrow(StateError)
  })
})
