import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ProviderAdapter } from '../../src/providers/types.js'

const { mockWaitForSsh, mockConnect } = vi.hoisted(() => ({
  mockWaitForSsh: vi.fn(),
  mockConnect: vi.fn(),
}))
// The overlay step opens a real session; without this the suite dials 1.2.3.4 and times out.
vi.mock('../../src/transport/ssh.js', () => ({ connect: mockConnect }))
vi.mock('../../src/transport/wait.js', () => ({ waitForSsh: mockWaitForSsh }))
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

/**
 * What a provider program actually exports. Tests used to hand back two fields, which could
 * not reach the code that reads a stack's connection details — part of why that code stayed
 * wrong so long.
 */
const REALISTIC_OUTPUTS = {
  instanceId:    { value: 'i-0abc' },
  publicIp:      { value: '1.2.3.4' },
  gatewayUrl:    { value: 'https://gw.example.com' },
  region:        { value: 'us-east-1' },
  provisionedAt: { value: '2026-09-14T00:00:00.000Z' },
  sshHost:       { value: '1.2.3.4' },
  sshPort:       { value: 22 },
  sshUser:       { value: 'clawops' },
}

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
    openclaw: { version: '2026.9.2' },
    // Every cloud program refuses to run without this. Carried by the plan so the suite does
    // not fall back to whatever key exists on the machine running it — which is how these
    // tests passed locally and failed in CI.
    ssh: { publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFIXTURE clawops' },
    network: { allowedSshCidrs: [], allowedGatewayCidrs: [] },
  },
}

beforeEach(async () => {
  mockWaitForSsh.mockReset().mockResolvedValue(undefined)
  mockConnect.mockReset().mockRejectedValue(new Error('no host in a unit test'))
  vi.clearAllMocks()

  mockUp.mockResolvedValue({
    outputs: REALISTIC_OUTPUTS,
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
    // The operator's SSH paths live here, not in stack outputs.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    config: { ssh: { keyPath: '~/.clawops/id_ed25519', knownHostsPath: '~/.clawops/known_hosts' } } as any,
    // apply waits for the instance to accept SSH before it reports success, so the adapter
    // has to answer where that instance is.
    adapter: {
      name: 'aws',
      // The real adapters read these two out of the object they are handed — they are the
      // operator's paths, not stack outputs — so the mock does too. apply used to pass raw
      // outputs and build a connection with an empty key path.
      getConnectionInfo: (o: Record<string, unknown>) => ({
        host: '203.0.113.4',
        port: 22,
        user: 'clawops',
        privateKeyPath: String(o['privateKeyPath'] ?? ''),
        knownHostsPath: String(o['knownHostsPath'] ?? ''),
      }),
    } as unknown as ProviderAdapter,
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
    expect(mockSetConfig).toHaveBeenCalledWith('openclawVersion', { value: '2026.9.2' })
  })

  it('passes the plan\'s firewall rules to Pulumi', async () => {
    // apply validated these, printed them in the plan summary, and then dropped them. Every
    // program reads them from stack config, so an empty value meant resolveIngressCidrs
    // returned [] and the stack was created with NO ingress rules — not a weaker rule, none.
    // clawops builds its own VPC, so nothing else opens SSH, and the instance was
    // unreachable by every day-two command.
    const { applyPlan } = await import('../../src/plan/apply.js')
    await applyPlan({
      ...basePlan,
      spec: {
        ...basePlan.spec,
        network: {
          allowedSshCidrs: ['203.0.113.4/32', '10.0.0.0/8'],
          allowedGatewayCidrs: [],
        },
      },
    } as unknown as typeof basePlan)

    expect(mockSetConfig).toHaveBeenCalledWith('sshCidrs', { value: '203.0.113.4/32,10.0.0.0/8' })
    expect(mockSetConfig).toHaveBeenCalledWith('gatewayCidrs', { value: '' })
    // Deny-all is the default the CIDRs open holes in (N10).
    expect(mockSetConfig).toHaveBeenCalledWith('accessMode', { value: 'restricted' })
  })

  it('sends the plan\'s SSH public key, without which no cloud program runs', async () => {
    const { applyPlan } = await import('../../src/plan/apply.js')
    await applyPlan(basePlan)
    expect(mockSetConfig).toHaveBeenCalledWith('sshPublicKey', {
      value: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFIXTURE clawops',
    })
  })

  it('pins the GCP project so the deploy lands where preflight looked', async () => {
    vi.stubEnv('GOOGLE_PROJECT', 'clawops-test')
    const { applyPlan } = await import('../../src/plan/apply.js')
    await applyPlan({
      ...basePlan,
      spec: { ...basePlan.spec, provider: 'gcp' },
    } as unknown as typeof basePlan)

    // GCP resolves the project from ambient config, so without this a deploy could land in
    // whichever project the environment named — not the one whose APIs and state bucket
    // `doctor` checked.
    expect(mockSetConfig).toHaveBeenCalledWith('gcp:project', { value: 'clawops-test' })
    vi.unstubAllEnvs()
  })

  it('does not pin a GCP project on another provider', async () => {
    vi.stubEnv('GOOGLE_PROJECT', 'clawops-test')
    const { applyPlan } = await import('../../src/plan/apply.js')
    await applyPlan(basePlan)
    expect(mockSetConfig).not.toHaveBeenCalledWith('gcp:project', expect.anything())
    vi.unstubAllEnvs()
  })

  it('passes gateway CIDRs when the plan publishes the gateway', async () => {
    const { applyPlan } = await import('../../src/plan/apply.js')
    await applyPlan({
      ...basePlan,
      spec: {
        ...basePlan.spec,
        network: {
          allowedSshCidrs: ['203.0.113.4/32'],
          allowedGatewayCidrs: ['203.0.113.4/32'],
          publishGateway: 'all',
        },
      },
    } as unknown as typeof basePlan)

    expect(mockSetConfig).toHaveBeenCalledWith('gatewayCidrs', { value: '203.0.113.4/32' })
    expect(mockSetConfig).toHaveBeenCalledWith('publishGateway', { value: 'all' })
  })

  it('sends empty CIDRs rather than omitting them, when the plan has no network', async () => {
    // An omitted key and an empty one are the same to the program, but sending it explicitly
    // keeps the stack config a faithful copy of the plan rather than a partial one.
    const { applyPlan } = await import('../../src/plan/apply.js')
    await applyPlan(basePlan)
    expect(mockSetConfig).toHaveBeenCalledWith('sshCidrs', { value: '' })
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
      return { outputs: REALISTIC_OUTPUTS, summary: {} }
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
    mockUp.mockResolvedValue({ outputs: REALISTIC_OUTPUTS, summary: {} })
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

describe('applyPlan waits for the instance to be reachable', () => {
  it('waits before reporting success', async () => {
    const { applyPlan } = await import('../../src/plan/apply.js')
    await applyPlan(basePlan)
    // Pulumi returns as soon as the API accepts the resource; sshd starts a good half-minute
    // later. apply used to print the gateway URL while every following command failed with
    // ECONNREFUSED.
    expect(mockWaitForSsh).toHaveBeenCalledWith(
      expect.objectContaining({ host: '203.0.113.4', port: 22, user: 'clawops' }),
      expect.anything(),
    )
  })

  it('fails the apply when the instance never becomes reachable', async () => {
    mockWaitForSsh.mockRejectedValue(new Error('did not accept SSH within 300s'))
    const { applyPlan } = await import('../../src/plan/apply.js')
    // Reporting success for a machine nothing can reach is the bug this replaced.
    await expect(applyPlan(basePlan)).rejects.toThrow(/did not accept SSH/)
  })

  it('waits before writing the config overlay, which connects immediately', async () => {
    const order: string[] = []
    mockWaitForSsh.mockImplementation(async () => void order.push('wait'))
    const { applyPlan } = await import('../../src/plan/apply.js')
    try {
      await applyPlan({
        ...basePlan,
        spec: { ...basePlan.spec, openclaw: { version: '2026.9.2', config: { gateway: {} } } },
      } as unknown as typeof basePlan)
    } catch {
      // The overlay step dials a host that does not exist in this suite; the ordering is what
      // matters, and it is recorded before that happens.
    }
    expect(order).toEqual(['wait'])
  })
})

describe('the connection apply waits on', () => {
  it('carries the operator\'s key, which stack outputs do not contain', async () => {
    const { applyPlan } = await import('../../src/plan/apply.js')
    await applyPlan(basePlan)
    // Passing raw outputs produced: Cannot read SSH private key at : ENOENT … open ''
    expect(mockWaitForSsh).toHaveBeenCalledWith(
      expect.objectContaining({
        privateKeyPath: expect.stringContaining('id_ed25519'),
        knownHostsPath: expect.stringContaining('known_hosts'),
      }),
      expect.anything(),
    )
  })

  it('expands ~ in the configured paths', async () => {
    const { applyPlan } = await import('../../src/plan/apply.js')
    await applyPlan(basePlan)
    const conn = mockWaitForSsh.mock.calls[0]?.[0] as { privateKeyPath: string }
    // ssh2 opens the path verbatim; "~" is a directory name to it.
    expect(conn.privateKeyPath.startsWith('~')).toBe(false)
  })
})
