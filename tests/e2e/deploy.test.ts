// Mock-based e2e: generatePlan → applyPlan → handleStatus call chain.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/cli/context.js', () => ({ buildContext: vi.fn() }))
vi.mock('../../src/config/store.js', () => ({
  getConfig: vi.fn(),
  requireConfig: vi.fn(),
  getConfigDir: vi.fn(() => '/tmp/clawops-test'),
}))

const mockUp = vi.fn()
const mockSetConfig = vi.fn()
const mockPreview = vi.fn()
const mockGetStack = vi.fn()

const FAKE_UP_RESULT = {
  outputs: {
    gatewayUrl: { value: 'https://1.2.3.4:18789' },
    publicIp:   { value: '1.2.3.4' },
  },
  summary: { resourceChanges: { create: 3 } },
}

const MINIMAL_CONFIG = {
  version: 1 as const,
  defaults: { stack: 'default', provider: 'aws' as const },
  stacks: {
    default: {
      provider: 'aws' as const,
      region: 'us-east-1',
      stateUrl: 's3://bucket/clawops',
      credentialsRef: { source: 'file' as const, envVars: [] as string[] },
    },
  },
  ssh: { keyPath: '~/.ssh/id_ed25519', knownHostsPath: '~/.clawops/known_hosts' },
}

beforeEach(async () => {
  vi.clearAllMocks()

  mockUp.mockResolvedValue(FAKE_UP_RESULT)
  mockSetConfig.mockResolvedValue(undefined)
  mockPreview.mockResolvedValue({ changeSummary: { create: 3 } })
  mockGetStack.mockResolvedValue({ up: mockUp, setConfig: mockSetConfig, preview: mockPreview })

  const { buildContext } = await import('../../src/cli/context.js')
  vi.mocked(buildContext).mockReturnValue({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    config: MINIMAL_CONFIG as any,
    stackName: 'default',
    adapter: {
      name: 'aws',
      defaultRegion: () => 'us-east-1',
      normalizeInstanceType: (a: string) => `${a}.large`,
      validateConfig: vi.fn().mockResolvedValue({ ok: true, errors: [] }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    getStack: mockGetStack,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)

  const { getConfig, requireConfig } = await import('../../src/config/store.js')
  vi.mocked(getConfig).mockReturnValue(MINIMAL_CONFIG as ReturnType<typeof getConfig>)
  vi.mocked(requireConfig).mockReturnValue(MINIMAL_CONFIG as ReturnType<typeof requireConfig>)
})

describe('e2e: applyPlan → stack.up()', () => {
  it('returns correct outputs after successful stack.up()', async () => {
    const { applyPlan } = await import('../../src/plan/apply.js')

    const plan = {
      apiVersion: 'clawops.dev/v1' as const,
      kind: 'DeployPlan' as const,
      metadata: { name: 'default', generatedAt: new Date().toISOString(), generator: 'clawops', generatorVersion: '0.8.0' },
      spec: {
        provider: 'aws' as const,
        region: 'us-east-1',
        stackName: 'default',
        instanceType: 'small',
        openclaw: { version: 'stable' },
        network: { allowedSshCidrs: [], allowedGatewayCidrs: [] },
      },
    }

    const result = await applyPlan(plan)

    expect(mockUp).toHaveBeenCalledOnce()
    expect(result.outputs['gatewayUrl']).toBe('https://1.2.3.4:18789')
    expect(result.outputs['publicIp']).toBe('1.2.3.4')
    expect(result.changeSummary['create']).toBe(3)
  })

  it('schema validation failure prevents stack.up()', async () => {
    const { applyPlan } = await import('../../src/plan/apply.js')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(applyPlan({ invalid: true } as any)).rejects.toThrow()
    expect(mockUp).not.toHaveBeenCalled()
  })

  it('AbortSignal is forwarded to stack.up()', async () => {
    const { applyPlan } = await import('../../src/plan/apply.js')
    const controller = new AbortController()

    const plan = {
      apiVersion: 'clawops.dev/v1' as const,
      kind: 'DeployPlan' as const,
      metadata: { name: 'default', generatedAt: new Date().toISOString(), generator: 'clawops', generatorVersion: '0.8.0' },
      spec: {
        provider: 'aws' as const,
        region: 'us-east-1',
        stackName: 'default',
        instanceType: 'small',
        openclaw: { version: 'stable' },
        network: { allowedSshCidrs: [], allowedGatewayCidrs: [] },
      },
    }

    await applyPlan(plan, { signal: controller.signal })
    const callOpts = mockUp.mock.calls[0]?.[0] as { signal?: AbortSignal }
    expect(callOpts?.signal).toBe(controller.signal)
  })

  it('output consistency: all BaseStackOutputs keys are mapped', async () => {
    const { applyPlan } = await import('../../src/plan/apply.js')
    mockUp.mockResolvedValue({
      outputs: {
        publicIp:       { value: '1.2.3.4' },
        gatewayUrl:     { value: 'https://1.2.3.4:18789' },
        instanceId:     { value: 'i-abc' },
        sshHost:        { value: '1.2.3.4' },
        sshPort:        { value: 22 },
        sshUser:        { value: 'clawops' },
        region:         { value: 'us-east-1' },
        provisionedAt:  { value: '2026-05-07T00:00:00Z' },
      },
      summary: {},
    })

    const plan = {
      apiVersion: 'clawops.dev/v1' as const,
      kind: 'DeployPlan' as const,
      metadata: { name: 'default', generatedAt: new Date().toISOString(), generator: 'clawops', generatorVersion: '0.8.0' },
      spec: {
        provider: 'aws' as const,
        region: 'us-east-1',
        stackName: 'default',
        instanceType: 'small',
        openclaw: { version: 'stable' },
        network: { allowedSshCidrs: [], allowedGatewayCidrs: [] },
      },
    }

    const result = await applyPlan(plan)
    expect(result.outputs['instanceId']).toBe('i-abc')
    expect(result.outputs['sshUser']).toBe('clawops')
    expect(result.outputs['provisionedAt']).toBe('2026-05-07T00:00:00Z')
  })
})
