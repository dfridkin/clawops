import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../src/cli/context.js', () => ({ buildContext: vi.fn() }))

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
  mockDestroy.mockResolvedValue(undefined)
  mockOutputs.mockResolvedValue({
    publicIp:   { value: '1.2.3.4' },
    gatewayUrl: { value: 'https://gw.example.com' },
  })

  mockBuildContext.mockReturnValue({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    config: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    adapter: { name: 'aws' } as any,
    stackName: 'default',
    getStack: vi.fn().mockResolvedValue({
      destroy: mockDestroy,
      outputs: mockOutputs,
    }),
  })

  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})

  const mod = await import('../../src/cli/commands/down.js')
  cmd = mod.default
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('down command', () => {
  it('requires --yes to destroy', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit') })
    await expect((cmd.run as AnyRunFn)({ args: {} })).rejects.toThrow('exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(mockDestroy).not.toHaveBeenCalled()
  })

  it('calls stack.destroy() when --yes is given', async () => {
    await (cmd.run as AnyRunFn)({ args: { yes: true } })
    expect(mockDestroy).toHaveBeenCalledOnce()
  })

  it('--dry-run prints outputs without destroying', async () => {
    const chunks: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((c) => { chunks.push(String(c)); return true })

    await (cmd.run as AnyRunFn)({ args: { 'dry-run': true } })

    expect(mockDestroy).not.toHaveBeenCalled()
    const output = chunks.join('')
    expect(output).toMatch(/publicIp|would/)
  })

  it('--dry-run does not require --yes', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit') })
    await (cmd.run as AnyRunFn)({ args: { 'dry-run': true } })
    expect(exitSpy).not.toHaveBeenCalled()
    expect(mockDestroy).not.toHaveBeenCalled()
  })

  it('propagates errors from stack.destroy()', async () => {
    mockDestroy.mockRejectedValue(new Error('destroy error'))
    await expect((cmd.run as AnyRunFn)({ args: { yes: true } })).rejects.toThrow('destroy error')
  })
})
