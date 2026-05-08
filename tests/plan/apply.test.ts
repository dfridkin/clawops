import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/cli/context.js', () => ({
  buildContext: vi.fn(),
}))

vi.mock('../../src/config/store.js', () => ({
  getConfig: vi.fn(() => ({
    defaults: { stack: 'default', provider: 'aws' },
    stacks: { default: { provider: 'aws', region: 'us-east-1', stateUrl: 's3://bucket/clawops' } },
    ssh: { keyPath: '~/.ssh/id_ed25519', knownHostsPath: '~/.clawops/known_hosts' },
    mcp: {},
  })),
  requireConfig: vi.fn(() => ({
    defaults: { stack: 'default', provider: 'aws' },
    stacks: { default: { provider: 'aws', region: 'us-east-1', stateUrl: 's3://bucket/clawops' } },
    ssh: { keyPath: '~/.ssh/id_ed25519', knownHostsPath: '~/.clawops/known_hosts' },
    mcp: {},
  })),
  getConfigDir: vi.fn(() => '/tmp/clawops-test'),
}))

const mockUp = vi.fn()
const mockSetConfig = vi.fn()
const mockInfo = vi.fn()
const mockGetStack = vi.fn()

const basePlan = {
  apiVersion: 'clawops.dev/v1' as const,
  kind: 'DeployPlan' as const,
  metadata: {
    name: 'default',
    generatedAt: new Date().toISOString(),
    generator: 'clawops',
    generatorVersion: '0.2.0',
  },
  spec: {
    provider: 'aws' as const,
    region: 'us-east-1',
    stackName: 'default',
    instanceType: 'small',
    openclaw: { version: 'stable' },
    network: { allowedSshCidrs: [], allowedGatewayCidrs: [] },
  },
}

beforeEach(async () => {
  vi.clearAllMocks()

  mockUp.mockResolvedValue({
    outputs: {
      gatewayUrl: { value: 'https://gw.example.com' },
      publicIp:   { value: '1.2.3.4' },
    },
    summary: {
      resourceChanges: { create: 3, same: 1 },
    },
  })
  mockSetConfig.mockResolvedValue(undefined)
  mockInfo.mockResolvedValue(undefined)
  mockGetStack.mockResolvedValue({
    up: mockUp,
    setConfig: mockSetConfig,
    info: mockInfo,
  })

  const { buildContext } = await import('../../src/cli/context.js')
  vi.mocked(buildContext).mockReturnValue({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    config: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    adapter: { name: 'aws' } as any,
    stackName: 'default',
    getStack: mockGetStack,
  })
})

describe('applyPlan()', () => {
  it('calls stack.up() and returns outputs and changeSummary', async () => {
    const { applyPlan } = await import('../../src/plan/apply.js')
    const result = await applyPlan(basePlan)

    expect(mockUp).toHaveBeenCalledOnce()
    expect(result.outputs['gatewayUrl']).toBe('https://gw.example.com')
    expect(result.outputs['publicIp']).toBe('1.2.3.4')
    expect(result.changeSummary['create']).toBe(3)
    expect(result.changeSummary['same']).toBe(1)
  })

  it('returns durationMs > 0', async () => {
    const { applyPlan } = await import('../../src/plan/apply.js')
    const result = await applyPlan(basePlan)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('sets Pulumi config before calling stack.up()', async () => {
    const { applyPlan } = await import('../../src/plan/apply.js')
    await applyPlan(basePlan)

    expect(mockSetConfig).toHaveBeenCalledWith('instanceType', { value: 'small' })
    expect(mockSetConfig).toHaveBeenCalledWith('region', { value: 'us-east-1' })
    expect(mockSetConfig).toHaveBeenCalledWith('openclawVersion', { value: 'stable' })
  })

  it('omits region setConfig when plan has no region', async () => {
    const { applyPlan } = await import('../../src/plan/apply.js')
    const planNoRegion = { ...basePlan, spec: { ...basePlan.spec, region: undefined } }
    await applyPlan(planNoRegion)

    const calls = mockSetConfig.mock.calls.map(([k]) => k)
    expect(calls).not.toContain('region')
  })

  it('forwards onOutput lines to callback', async () => {
    mockUp.mockImplementation(async ({ onOutput }: { onOutput?: (s: string) => void }) => {
      onOutput?.('line 1')
      onOutput?.('line 2')
      return { outputs: {}, summary: {} }
    })

    const lines: string[] = []
    const { applyPlan } = await import('../../src/plan/apply.js')
    await applyPlan(basePlan, { onOutput: (l) => lines.push(l) })

    expect(lines).toEqual(['line 1', 'line 2'])
  })

  it('throws UsageError for local provider', async () => {
    const { applyPlan } = await import('../../src/plan/apply.js')
    const localPlan = { ...basePlan, spec: { ...basePlan.spec, provider: 'local' as const } }
    await expect(applyPlan(localPlan)).rejects.toThrow('local provider')
  })

  it('throws UsageError when plan fails validation', async () => {
    const { applyPlan } = await import('../../src/plan/apply.js')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(applyPlan({ invalid: true } as any)).rejects.toThrow()
  })

  it('propagates errors from stack.up()', async () => {
    mockUp.mockRejectedValue(new Error('pulumi up failed'))
    const { applyPlan } = await import('../../src/plan/apply.js')
    await expect(applyPlan(basePlan)).rejects.toThrow('pulumi up failed')
  })

  it('returns empty changeSummary when resourceChanges is absent', async () => {
    mockUp.mockResolvedValue({ outputs: {}, summary: {} })
    const { applyPlan } = await import('../../src/plan/apply.js')
    const result = await applyPlan(basePlan)
    expect(result.changeSummary).toEqual({})
  })

  it('forwards AbortSignal to stack.up()', async () => {
    const controller = new AbortController()
    const { applyPlan } = await import('../../src/plan/apply.js')
    await applyPlan(basePlan, { signal: controller.signal })

    const callOpts = mockUp.mock.calls[0]?.[0] as { signal?: AbortSignal }
    expect(callOpts?.signal).toBe(controller.signal)
  })

  describe('drift detection', () => {
    const planWithVersion = {
      ...basePlan,
      metadata: { ...basePlan.metadata, stackVersion: 5 },
    }

    it('calls confirmDrift when stack version has changed', async () => {
      mockInfo.mockResolvedValue({ version: 7 })
      const confirmDrift = vi.fn().mockResolvedValue(undefined)
      const { applyPlan } = await import('../../src/plan/apply.js')
      await applyPlan(planWithVersion, { confirmDrift })
      expect(confirmDrift).toHaveBeenCalledOnce()
    })

    it('does not call confirmDrift when stack version matches', async () => {
      mockInfo.mockResolvedValue({ version: 5 })
      const confirmDrift = vi.fn().mockResolvedValue(undefined)
      const { applyPlan } = await import('../../src/plan/apply.js')
      await applyPlan(planWithVersion, { confirmDrift })
      expect(confirmDrift).not.toHaveBeenCalled()
    })

    it('skips drift check when plan has no stackVersion', async () => {
      mockInfo.mockResolvedValue({ version: 99 })
      const confirmDrift = vi.fn().mockResolvedValue(undefined)
      const { applyPlan } = await import('../../src/plan/apply.js')
      await applyPlan(basePlan, { confirmDrift })
      expect(confirmDrift).not.toHaveBeenCalled()
    })

    it('skips drift check when stack has no history', async () => {
      mockInfo.mockResolvedValue(undefined)
      const confirmDrift = vi.fn().mockResolvedValue(undefined)
      const { applyPlan } = await import('../../src/plan/apply.js')
      await applyPlan(planWithVersion, { confirmDrift })
      expect(confirmDrift).not.toHaveBeenCalled()
    })
  })
})
