// Unit tests for the `up` command — local bootstrap + cloud Pulumi paths.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeLocalFakeContext, FAKE_LOCAL_STATE } from '../helpers/context.js'

// ── Mocks declared at module level so they share the same vi.fn() instances ──
vi.mock('../../src/cli/context.js', () => ({ buildContext: vi.fn() }))
vi.mock('../../src/providers/local/bootstrap.js', () => ({ localBootstrap: vi.fn() }))

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
        openclawVersion: 'stable',
      }),
    )
  })

  it('passes --openclaw-version to bootstrap', async () => {
    mockBuildContext.mockReturnValue(makeLocalFakeContext(FAKE_LOCAL_STATE))
    mockLocalBootstrap.mockResolvedValue(FAKE_LOCAL_STATE)

    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await (cmd.run as AnyRunFn)({ args: { 'openclaw-version': '2099.1' } })

    expect(mockLocalBootstrap).toHaveBeenCalledWith(
      expect.objectContaining({ openclawVersion: '2099.1' }),
    )
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
})

describe('up command — cloud provider path', () => {
  beforeEach(() => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('calls stack.up() and prints public IP when confirmed', async () => {
    const { ctx, mockUp } = makeCloudContext()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockBuildContext.mockReturnValue(ctx as any)

    await (cmd.run as AnyRunFn)({ args: { 'instance-type': 'small' } })
    expect(mockUp).toHaveBeenCalledOnce()
  })

  it('calls setConfig with instance type and region before stack.up()', async () => {
    const { ctx, mockSetConfig } = makeCloudContext()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockBuildContext.mockReturnValue(ctx as any)

    await (cmd.run as AnyRunFn)({ args: { 'instance-type': 'small', region: 'eu-west-1' } })
    expect(mockSetConfig).toHaveBeenCalledWith('region', { value: 'eu-west-1' })
    expect(mockSetConfig).toHaveBeenCalledWith('instanceType', expect.any(Object))
    expect(mockSetConfig).toHaveBeenCalledWith('openclawVersion', { value: 'stable' })
  })

  it('runs preview (not up) when --dry-run is set', async () => {
    const { ctx, mockUp, mockPreview } = makeCloudContext()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockBuildContext.mockReturnValue(ctx as any)

    await (cmd.run as AnyRunFn)({ args: { 'instance-type': 'small', 'dry-run': true } })
    expect(mockPreview).toHaveBeenCalledOnce()
    expect(mockUp).not.toHaveBeenCalled()
  })

  it('uses default instance type "small" when --instance-type is absent', async () => {
    const { ctx, mockSetConfig } = makeCloudContext()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockBuildContext.mockReturnValue(ctx as any)

    await (cmd.run as AnyRunFn)({ args: {} })
    const instanceTypeCall = mockSetConfig.mock.calls.find(([k]) => k === 'instanceType')
    expect(instanceTypeCall).toBeDefined()
  })

  it('throws UsageError for unknown --instance-type', async () => {
    const { ctx } = makeCloudContext()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockBuildContext.mockReturnValue(ctx as any)

    await expect((cmd.run as AnyRunFn)({ args: { 'instance-type': 'gigantic' } })).rejects.toThrow('gigantic')
  })

  it('propagates stack.up() errors', async () => {
    const { ctx, mockUp } = makeCloudContext()
    mockUp.mockRejectedValue(new Error('pulumi: out of quota'))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockBuildContext.mockReturnValue(ctx as any)

    await expect((cmd.run as AnyRunFn)({ args: {} })).rejects.toThrow('pulumi: out of quota')
  })
})
