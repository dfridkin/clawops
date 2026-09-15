// Unit tests for the `up` command — local bootstrap + cloud Pulumi paths.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeLocalFakeContext, FAKE_LOCAL_STATE } from '../helpers/context.js'

// ── Mocks declared at module level so they share the same vi.fn() instances ──
vi.mock('../../src/cli/context.js', () => ({ buildContext: vi.fn() }))
vi.mock('../../src/providers/local/bootstrap.js', () => ({ localBootstrap: vi.fn() }))
const { mockGeneratePlan, mockApplyPlan, mockDetectEgressIp } = vi.hoisted(() => ({
  mockGeneratePlan: vi.fn(),
  mockApplyPlan: vi.fn(),
  mockDetectEgressIp: vi.fn(),
}))
vi.mock('../../src/plan/generate.js', () => ({ generatePlan: mockGeneratePlan }))
vi.mock('../../src/plan/apply.js', () => ({ applyPlan: mockApplyPlan }))
vi.mock('../../src/providers/firewall.js', () => ({ detectEgressIp: mockDetectEgressIp }))

/** A plan is opaque to `up`: it generates one and hands it to apply. */
const PLAN = {
  apiVersion: 'clawops.dev/v1',
  kind: 'DeployPlan',
  metadata: { name: 'default', generatedAt: '', generator: 'clawops', generatorVersion: '2.0.0' },
  spec: { provider: 'aws', stackName: 'default', instanceType: 't3.small', openclaw: { version: '2026.9.2' } },
  diff: { create: [{ urn: 'u', type: 't' }], update: [], delete: [], totalChanges: 1 },
}

import { buildContext } from '../../src/cli/context.js'
import { localBootstrap } from '../../src/providers/local/bootstrap.js'

const mockBuildContext = vi.mocked(buildContext)
const mockLocalBootstrap = vi.mocked(localBootstrap)

function makeCloudContext(overrides: Record<string, unknown> = {}) {
  const mockSetConfig = vi.fn().mockResolvedValue(undefined)
  const mockUp = vi.fn().mockResolvedValue({
    outputs: {
      publicIp: { value: '1.2.3.4' },
      gatewayUrl: { value: 'https://1.2.3.4:18789' },
    },
    summary: { resourceChanges: { create: 2 } },
  })
  const mockPreview = vi.fn().mockResolvedValue({
    changeSummary: { create: 2 },
  })
  const mockGetStack = vi.fn().mockResolvedValue({ up: mockUp, setConfig: mockSetConfig, preview: mockPreview })
  const ctx = {
    config: {},
    stackName: 'default',
    adapter: {
      name: 'aws',
      defaultRegion: () => 'us-east-1',
      normalizeInstanceType: (a: string) => `${a}.large`,
      validateConfig: vi.fn().mockResolvedValue({ ok: true, errors: [] }),
    },
    getStack: mockGetStack,
    ...overrides,
  }
  return { ctx, mockUp, mockPreview, mockSetConfig, mockGetStack }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRunFn = (ctx: any) => Promise<void>

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cmd: any

beforeEach(async () => {
  vi.clearAllMocks()
  const mod = await import('../../src/cli/commands/up.js')
  cmd = mod.default
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('up command — local provider', () => {
  it('calls localBootstrap with correct opts from localOpts', async () => {
    mockBuildContext.mockReturnValue(makeLocalFakeContext(FAKE_LOCAL_STATE))
    mockLocalBootstrap.mockResolvedValue(FAKE_LOCAL_STATE)

    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await (cmd.run as AnyRunFn)({ args: { stack: undefined } })

    expect(mockLocalBootstrap).toHaveBeenCalledWith(
      expect.objectContaining({
        host: '10.0.0.1',
        port: 22,
        user: 'root',
        openclawVersion: '2026.9.2',
      }),
    )
  })

  it('passes --openclaw-version to bootstrap', async () => {
    mockBuildContext.mockReturnValue(makeLocalFakeContext(FAKE_LOCAL_STATE))
    mockLocalBootstrap.mockResolvedValue(FAKE_LOCAL_STATE)

    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await (cmd.run as AnyRunFn)({ args: { 'openclaw-version': '2026.9.2' } })

    expect(mockLocalBootstrap).toHaveBeenCalledWith(
      expect.objectContaining({ openclawVersion: '2026.9.2' }),
    )
  })

  it('refuses an OpenClaw version outside the supported range', async () => {
    mockBuildContext.mockReturnValue(makeLocalFakeContext(FAKE_LOCAL_STATE))
    mockLocalBootstrap.mockResolvedValue(FAKE_LOCAL_STATE)
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    // 2026.7.1-2 is the last pre-2.0 release: a different container runtime contract that
    // this line cannot deploy — it mounts a writable state directory, writes gateway.mode
    // and passes no --allow-unconfigured. Refused BEFORE anything is provisioned.
    await expect(
      (cmd.run as AnyRunFn)({ args: { 'openclaw-version': '2026.7.1-2' } }),
    ).rejects.toThrow(/2026\.9\.2|supported|range/i)

    expect(mockLocalBootstrap).not.toHaveBeenCalled()
  })

  it('refuses an unresolved moving tag rather than assuming it is safe', async () => {
    mockBuildContext.mockReturnValue(makeLocalFakeContext(FAKE_LOCAL_STATE))
    mockLocalBootstrap.mockResolvedValue(FAKE_LOCAL_STATE)
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await expect(
      (cmd.run as AnyRunFn)({ args: { 'openclaw-version': 'latest' } }),
    ).rejects.toThrow(/moving tag/)

    expect(mockLocalBootstrap).not.toHaveBeenCalled()
  })

  it('passes --no-wait to bootstrap', async () => {
    mockBuildContext.mockReturnValue(makeLocalFakeContext(FAKE_LOCAL_STATE))
    mockLocalBootstrap.mockResolvedValue(FAKE_LOCAL_STATE)

    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await (cmd.run as AnyRunFn)({ args: { 'no-wait': true } })

    expect(mockLocalBootstrap).toHaveBeenCalledWith(
      expect.objectContaining({ noWait: true }),
    )
  })

  it('prints gateway URL and SSH info after successful bootstrap', async () => {
    mockBuildContext.mockReturnValue(makeLocalFakeContext(FAKE_LOCAL_STATE))
    mockLocalBootstrap.mockResolvedValue(FAKE_LOCAL_STATE)

    const logs: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.join(' ')) })

    await (cmd.run as AnyRunFn)({ args: {} })

    const output = logs.join('\n')
    expect(output).toMatch(/18789|gateway/i)
  })

  it('throws UsageError when localOpts is missing from stack config', async () => {
    const ctxNoOpts = makeLocalFakeContext(FAKE_LOCAL_STATE)
    // Deep-copy config so we don't mutate the shared LOCAL_CONFIG constant
    const configNoOpts = JSON.parse(JSON.stringify(ctxNoOpts.config)) as typeof ctxNoOpts.config
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (configNoOpts.stacks['local-default'] as any).localOpts
    mockBuildContext.mockReturnValue({ ...ctxNoOpts, config: configNoOpts })

    const { UsageError } = await import('../../src/errors/index.js')
    await expect((cmd.run as AnyRunFn)({ args: {} })).rejects.toBeInstanceOf(UsageError)
  })

  it('propagates bootstrap errors', async () => {
    mockBuildContext.mockReturnValue(makeLocalFakeContext(FAKE_LOCAL_STATE))
    mockLocalBootstrap.mockRejectedValue(new Error('SSH connection refused'))

    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await expect((cmd.run as AnyRunFn)({ args: {} })).rejects.toThrow('SSH connection refused')
  })

  it('passes --gateway-port through to bootstrap', async () => {
    mockBuildContext.mockReturnValue(makeLocalFakeContext(FAKE_LOCAL_STATE))
    mockLocalBootstrap.mockResolvedValue(FAKE_LOCAL_STATE)
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await (cmd.run as AnyRunFn)({ args: { 'gateway-port': '9443' } })

    expect(mockLocalBootstrap).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayPort: 9443 }),
    )
  })

  it('leaves the port unset when the flag is absent, so bootstrap picks the default', async () => {
    mockBuildContext.mockReturnValue(makeLocalFakeContext(FAKE_LOCAL_STATE))
    mockLocalBootstrap.mockResolvedValue(FAKE_LOCAL_STATE)
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await (cmd.run as AnyRunFn)({ args: {} })

    expect(mockLocalBootstrap).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayPort: undefined }),
    )
  })

  it.each(['0', '65536', '-1', 'https', '80.5'])(
    'refuses --gateway-port %s rather than falling back to the default',
    async (raw) => {
      // A typo'd port that silently became 18789 would publish the gateway somewhere the
      // operator did not ask for and report success.
      mockBuildContext.mockReturnValue(makeLocalFakeContext(FAKE_LOCAL_STATE))
      mockLocalBootstrap.mockResolvedValue(FAKE_LOCAL_STATE)
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      vi.spyOn(console, 'log').mockImplementation(() => {})

      await expect((cmd.run as AnyRunFn)({ args: { 'gateway-port': raw } }))
        .rejects.toThrow(/gateway-port/)
      expect(mockLocalBootstrap).not.toHaveBeenCalled()
    },
  )

})

describe('up command — cloud provider path', () => {
  beforeEach(() => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mockGeneratePlan.mockReset().mockResolvedValue(PLAN)
    mockApplyPlan.mockReset().mockResolvedValue({
      outputs: { publicIp: '1.2.3.4', gatewayUrl: 'https://1.2.3.4:18789' },
      changeSummary: { create: 2 },
      durationMs: 1,
    })
    mockDetectEgressIp.mockReset().mockResolvedValue({ ok: true, ip: '203.0.113.4' })
  })

  /**
   * `up` used to be a second implementation of deploying: it wrote three pieces of stack
   * config and none of the rest, so the Pulumi programs refused to run for want of
   * sshPublicKey, no firewall rule was created, and it waited for nothing. It goes through the
   * same plan and the same apply as `clawops apply` now, which is what these assert.
   */
  it('deploys through the shared plan and apply, not a second implementation', async () => {
    const { ctx } = makeCloudContext()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockBuildContext.mockReturnValue(ctx as any)

    await (cmd.run as AnyRunFn)({ args: { 'instance-type': 'small' } })

    expect(mockGeneratePlan).toHaveBeenCalledWith(
      expect.objectContaining({ stackName: 'default', provider: 'aws', instanceType: 'small' }),
      expect.anything(),
    )
    expect(mockApplyPlan).toHaveBeenCalledWith(PLAN, expect.anything())
  })

  it('passes the region through to the plan', async () => {
    const { ctx } = makeCloudContext()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockBuildContext.mockReturnValue(ctx as any)
    await (cmd.run as AnyRunFn)({ args: { region: 'eu-west-1' } })
    expect(mockGeneratePlan).toHaveBeenCalledWith(
      expect.objectContaining({ region: 'eu-west-1' }),
      expect.anything(),
    )
  })

  it('accepts --ssh-cidr, so a cloud stack can be reachable at all', async () => {
    const { ctx } = makeCloudContext()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockBuildContext.mockReturnValue(ctx as any)
    await (cmd.run as AnyRunFn)({ args: { 'ssh-cidr': 'auto' } })
    expect(mockGeneratePlan).toHaveBeenCalledWith(
      expect.objectContaining({
        network: expect.objectContaining({ allowedSshCidrs: ['203.0.113.4/32'] }),
      }),
      expect.anything(),
    )
  })

  it('carries --gateway-port into the plan, not just to local stacks', async () => {
    const { ctx } = makeCloudContext()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockBuildContext.mockReturnValue(ctx as any)
    await (cmd.run as AnyRunFn)({ args: { 'gateway-port': '9443' } })
    expect(mockGeneratePlan).toHaveBeenCalledWith(
      expect.objectContaining({ network: expect.objectContaining({ gatewayPort: 9443 }) }),
      expect.anything(),
    )
  })

  it('shows the plan diff and applies nothing when --dry-run is set', async () => {
    const { ctx } = makeCloudContext()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockBuildContext.mockReturnValue(ctx as any)
    await (cmd.run as AnyRunFn)({ args: { 'dry-run': true } })
    expect(mockGeneratePlan).toHaveBeenCalledOnce()
    expect(mockApplyPlan).not.toHaveBeenCalled()
  })

  it('asks apply to skip the readiness waits for --no-wait', async () => {
    const { ctx } = makeCloudContext()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockBuildContext.mockReturnValue(ctx as any)
    await (cmd.run as AnyRunFn)({ args: { 'no-wait': true } })
    expect(mockApplyPlan).toHaveBeenCalledWith(
      PLAN,
      expect.objectContaining({ skipReadiness: true }),
    )
  })

  it('waits by default — an unusable stack is a terrible default', async () => {
    const { ctx } = makeCloudContext()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockBuildContext.mockReturnValue(ctx as any)
    await (cmd.run as AnyRunFn)({ args: {} })
    expect(mockApplyPlan).toHaveBeenCalledWith(
      PLAN,
      expect.objectContaining({ skipReadiness: false }),
    )
  })

  it('accepts a provider-native instance type, which may be the only one on offer', async () => {
    // Azure offers SKU families per subscription; `up` used to reject anything but its five
    // aliases, and on a subscription offered none of them that left no way to deploy.
    const { ctx } = makeCloudContext()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockBuildContext.mockReturnValue(ctx as any)
    await (cmd.run as AnyRunFn)({ args: { 'instance-type': 'Standard_D2als_v7' } })
    expect(mockGeneratePlan).toHaveBeenCalledWith(
      expect.objectContaining({ instanceType: 'Standard_D2als_v7' }),
      expect.anything(),
    )
  })

  it('propagates a failed apply', async () => {
    const { ctx } = makeCloudContext()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockBuildContext.mockReturnValue(ctx as any)
    mockApplyPlan.mockRejectedValue(new Error('pulumi: out of quota'))
    await expect((cmd.run as AnyRunFn)({ args: {} })).rejects.toThrow('pulumi: out of quota')
  })

  it('refuses to deploy when the provider has no credentials', async () => {
    const { ctx } = makeCloudContext()
    ctx.adapter.validateConfig = vi.fn().mockResolvedValue({ ok: false, errors: ['no creds'] })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockBuildContext.mockReturnValue(ctx as any)
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit')
    }) as never)
    try {
      await expect((cmd.run as AnyRunFn)({ args: {} })).rejects.toThrow('exit')
      expect(mockGeneratePlan).not.toHaveBeenCalled()
    } finally {
      exit.mockRestore()
    }
  })
})
