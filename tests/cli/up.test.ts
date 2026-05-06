// Unit tests for the `up` command — local bootstrap path.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeLocalFakeContext, FAKE_LOCAL_STATE } from '../helpers/context.js'

// ── Mocks declared at module level so they share the same vi.fn() instances ──
vi.mock('../../src/cli/context.js', () => ({ buildContext: vi.fn() }))
vi.mock('../../src/providers/local/bootstrap.js', () => ({ localBootstrap: vi.fn() }))

import { buildContext } from '../../src/cli/context.js'
import { localBootstrap } from '../../src/providers/local/bootstrap.js'

const mockBuildContext = vi.mocked(buildContext)
const mockLocalBootstrap = vi.mocked(localBootstrap)

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
