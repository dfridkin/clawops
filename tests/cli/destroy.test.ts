import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../src/cli/context.js', () => ({ buildContext: vi.fn() }))
const { mockForgetHost } = vi.hoisted(() => ({ mockForgetHost: vi.fn() }))
vi.mock('../../src/transport/known-hosts-file.js', () => ({ forgetHost: mockForgetHost }))

const mockQuestion = vi.fn()
const mockClose = vi.fn()
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({ question: mockQuestion, close: mockClose })),
}))

const mockDestroy = vi.fn()
const mockOutputs = vi.fn()

import { buildContext } from '../../src/cli/context.js'
const mockBuildContext = vi.mocked(buildContext)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRunFn = (ctx: any) => Promise<void>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cmd: any

beforeEach(async () => {
  vi.clearAllMocks()
  mockQuestion.mockResolvedValue('y')
  mockForgetHost.mockReturnValue(true)
  // What a provider program exports, so the code that reads a stack's connection details is
  // actually reachable from here.
  mockOutputs.mockResolvedValue({
    instanceId: { value: 'i-0abc' },
    publicIp: { value: '1.2.3.4' },
    gatewayUrl: { value: 'https://gw.example.com' },
    region: { value: 'us-east-1' },
    provisionedAt: { value: '2026-09-14T00:00:00.000Z' },
    sshHost: { value: '1.2.3.4' },
    sshPort: { value: 22 },
    sshUser: { value: 'clawops' },
  })
  mockDestroy.mockResolvedValue(undefined)

  mockBuildContext.mockReturnValue({
    config: {
      ssh: { keyPath: '~/.clawops/id_ed25519', knownHostsPath: '~/.clawops/known_hosts' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    adapter: {
      name: 'aws',
      getConnectionInfo: (o: Record<string, unknown>) => ({
        host: String(o['sshHost'] ?? ''),
        port: Number(o['sshPort'] ?? 22),
        user: 'clawops',
        privateKeyPath: String(o['privateKeyPath'] ?? ''),
        knownHostsPath: String(o['knownHostsPath'] ?? ''),
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    stackName: 'default',
    getStack: vi.fn().mockResolvedValue({
      destroy: mockDestroy,
      outputs: mockOutputs,
    }),
  })

  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.spyOn(console, 'log').mockImplementation(() => {})

  const mod = await import('../../src/cli/commands/destroy.js')
  cmd = mod.default
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('destroy command', () => {
  it('throws UsageError for local provider', async () => {
    mockBuildContext.mockReturnValue({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      config: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      adapter: { name: 'local' } as any,
      stackName: 'local-stack',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getStack: vi.fn() as any,
    })
    const { UsageError } = await import('../../src/errors/index.js')
    await expect(
      (cmd.run as AnyRunFn)({ args: { yes: true } }),
    ).rejects.toBeInstanceOf(UsageError)
  })

  it('--dry-run prints summary without destroying', async () => {
    await (cmd.run as AnyRunFn)({ args: { 'dry-run': true } })
    expect(mockDestroy).not.toHaveBeenCalled()
    expect(mockQuestion).not.toHaveBeenCalled()
  })

  it('--dry-run shows current outputs table', async () => {
    const chunks: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((c) => { chunks.push(String(c)); return true })

    await (cmd.run as AnyRunFn)({ args: { 'dry-run': true } })

    const output = chunks.join('')
    expect(output).toMatch(/publicIp|gatewayUrl|would/)
  })

  it('prompts for confirmation without --yes', async () => {
    await (cmd.run as AnyRunFn)({ args: {} })
    expect(mockQuestion).toHaveBeenCalledOnce()
    expect(mockDestroy).toHaveBeenCalledOnce()
  })

  it('exits without destroying when confirmation is declined', async () => {
    mockQuestion.mockResolvedValue('n')
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit') })

    await expect((cmd.run as AnyRunFn)({ args: {} })).rejects.toThrow('exit')
    expect(mockDestroy).not.toHaveBeenCalled()
  })

  it('skips prompt and destroys when --yes is passed', async () => {
    await (cmd.run as AnyRunFn)({ args: { yes: true } })
    expect(mockQuestion).not.toHaveBeenCalled()
    expect(mockDestroy).toHaveBeenCalledOnce()
  })

  it('propagates errors from stack.destroy()', async () => {
    mockDestroy.mockRejectedValue(new Error('pulumi destroy failed'))
    await expect(
      (cmd.run as AnyRunFn)({ args: { yes: true } }),
    ).rejects.toThrow('pulumi destroy failed')
  })
})

describe('the host key of a destroyed instance', () => {
  it('is forgotten, because the instance that owned it is gone', async () => {
    // A cloud provider hands addresses back out. Without this, deploying again onto the same
    // address fails host-key verification over a machine that no longer exists — which is
    // exactly what happened on the tenth end-to-end run.
    await (cmd.run as AnyRunFn)({ args: { yes: true } })
    expect(mockForgetHost).toHaveBeenCalledWith(
      expect.stringContaining('known_hosts'),
      '1.2.3.4',
      22,
    )
  })

  it('is read before the destroy, while the stack still has outputs', async () => {
    const order: string[] = []
    mockOutputs.mockImplementation(async () => {
      order.push('outputs')
      return {
        instanceId: { value: 'i-0abc' },
        publicIp: { value: '1.2.3.4' },
        gatewayUrl: { value: 'https://gw' },
        region: { value: 'us-east-1' },
        provisionedAt: { value: '2026-09-14T00:00:00.000Z' },
        sshHost: { value: '1.2.3.4' },
        sshPort: { value: 22 },
        sshUser: { value: 'clawops' },
      }
    })
    mockDestroy.mockImplementation(async () => void order.push('destroy'))
    await (cmd.run as AnyRunFn)({ args: { yes: true } })
    expect(order).toEqual(['outputs', 'destroy'])
  })

  it('expands ~ in the configured path', async () => {
    await (cmd.run as AnyRunFn)({ args: { yes: true } })
    const path = String(mockForgetHost.mock.calls[0]?.[0])
    expect(path.startsWith('~')).toBe(false)
  })

  it('is left alone when the stack has no outputs to name a host', async () => {
    mockOutputs.mockRejectedValue(new Error('no outputs'))
    await (cmd.run as AnyRunFn)({ args: { yes: true } })
    expect(mockForgetHost).not.toHaveBeenCalled()
  })

  it('is not touched on a dry run', async () => {
    await (cmd.run as AnyRunFn)({ args: { 'dry-run': true } })
    expect(mockForgetHost).not.toHaveBeenCalled()
  })
})
