import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGetConfig, mockResolvePublicKey, mockResolveProjectId } = vi.hoisted(() => ({
  mockGetConfig: vi.fn(),
  mockResolvePublicKey: vi.fn(),
  mockResolveProjectId: vi.fn(),
}))
vi.mock('../../src/config/store.js', () => ({ getConfig: mockGetConfig }))
vi.mock('../../src/plan/ssh-key.js', () => ({ resolvePublicKey: mockResolvePublicKey }))
vi.mock('../../src/providers/gcp/preflight.js', () => ({ resolveProjectId: mockResolveProjectId }))

import { writeStackConfig } from '../../src/plan/stack-config.js'
import type { DeployPlan } from '../../src/plan/generate.js'

const KEY = 'ssh-ed25519 AAAAC3Nz key'

function plan(overrides: Record<string, unknown> = {}): DeployPlan {
  return {
    apiVersion: 'clawops.dev/v1',
    kind: 'DeployPlan',
    metadata: { name: 'e2e', generatedAt: '', generator: 'clawops', generatorVersion: '2.0.0' },
    spec: {
      provider: 'aws',
      region: 'us-east-1',
      stackName: 'e2e',
      instanceType: 'small',
      openclaw: { version: '2026.9.2' },
      network: { allowedSshCidrs: ['10.0.0.0/8'], allowedGatewayCidrs: [] },
      ssh: { publicKey: KEY },
      ...overrides,
    },
  } as unknown as DeployPlan
}

let setConfig: ReturnType<typeof vi.fn>
const stack = () => ({ setConfig })
const sent = () => Object.fromEntries(setConfig.mock.calls.map(([k, v]) => [k, v.value]))

beforeEach(() => {
  setConfig = vi.fn().mockResolvedValue(undefined)
  mockGetConfig.mockReturnValue(null)
  mockResolvePublicKey.mockReturnValue(undefined)
  mockResolveProjectId.mockReturnValue(undefined)
})

describe('writeStackConfig', () => {
  it('sends every key a program reads', async () => {
    await writeStackConfig(stack(), plan())
    expect(sent()).toMatchObject({
      sshPublicKey: KEY,
      instanceType: 'small',
      region: 'us-east-1',
      openclawVersion: '2026.9.2',
      publishGateway: 'loopback',
      gatewayPort: '18789',
      accessMode: 'restricted',
      sshCidrs: '10.0.0.0/8',
      gatewayCidrs: '',
    })
  })

  it('sends the SSH key, without which every cloud program refuses to run', async () => {
    await writeStackConfig(stack(), plan())
    expect(setConfig).toHaveBeenCalledWith('sshPublicKey', { value: KEY })
  })

  it('falls back to the configured key for a plan generated before keys were recorded', async () => {
    mockGetConfig.mockReturnValue({ ssh: { keyPath: '~/.clawops/id_ed25519' } })
    mockResolvePublicKey.mockReturnValue('ssh-ed25519 FALLBACK key')
    await writeStackConfig(stack(), plan({ ssh: undefined }))
    expect(sent()['sshPublicKey']).toBe('ssh-ed25519 FALLBACK key')
  })

  it('expands ~ before looking for the key', async () => {
    mockGetConfig.mockReturnValue({ ssh: { keyPath: '~/.clawops/id_ed25519' } })
    mockResolvePublicKey.mockReturnValue(KEY)
    await writeStackConfig(stack(), plan({ ssh: undefined }))
    expect(mockResolvePublicKey).toHaveBeenCalledWith(
      `${process.env['HOME']}/.clawops/id_ed25519`,
    )
  })

  it('refuses rather than deploying an instance nobody can log into', async () => {
    await expect(writeStackConfig(stack(), plan({ ssh: undefined }))).rejects.toThrow(
      /no SSH public key/,
    )
    expect(setConfig).not.toHaveBeenCalled()
  })

  it('joins multiple CIDRs the way the programs split them', async () => {
    await writeStackConfig(
      stack(),
      plan({
        network: { allowedSshCidrs: ['10.0.0.0/8', '192.168.0.0/16'], allowedGatewayCidrs: [] },
      }),
    )
    expect(sent()['sshCidrs']).toBe('10.0.0.0/8,192.168.0.0/16')
  })

  it('sends empty values rather than omitting them when a plan has no network', async () => {
    await writeStackConfig(stack(), plan({ network: undefined }))
    expect(sent()).toMatchObject({ sshCidrs: '', gatewayCidrs: '', accessMode: 'restricted' })
  })

  it('carries the gateway port and publish mode from the plan', async () => {
    await writeStackConfig(
      stack(),
      plan({
        network: {
          allowedSshCidrs: [],
          allowedGatewayCidrs: ['10.0.0.0/8'],
          publishGateway: 'all',
          gatewayPort: 9999,
        },
      }),
    )
    expect(sent()).toMatchObject({
      publishGateway: 'all',
      gatewayPort: '9999',
      gatewayCidrs: '10.0.0.0/8',
    })
  })

  it('pins the GCP project, and only for GCP', async () => {
    mockResolveProjectId.mockReturnValue('clawops-test')
    await writeStackConfig(stack(), plan({ provider: 'gcp' }))
    expect(sent()['gcp:project']).toBe('clawops-test')

    setConfig.mockClear()
    await writeStackConfig(stack(), plan({ provider: 'aws' }))
    expect(sent()).not.toHaveProperty('gcp:project')
  })

  it('omits the region when the plan has none', async () => {
    await writeStackConfig(stack(), plan({ region: undefined }))
    expect(sent()).not.toHaveProperty('region')
  })

  it('enables Bedrock only when the plan selects it', async () => {
    await writeStackConfig(stack(), plan())
    expect(sent()).not.toHaveProperty('bedrockEnabled')

    setConfig.mockClear()
    await writeStackConfig(
      stack(),
      plan({ openclaw: { version: '2026.9.2', config: { models: { provider: 'bedrock' } } } }),
    )
    expect(sent()['bedrockEnabled']).toBe('true')
  })
})
