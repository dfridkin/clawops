import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeLocalFakeContext } from '../helpers/context.js'

vi.mock('../../src/cli/context.js', () => ({ buildContext: vi.fn() }))

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
  mockOutputs.mockResolvedValue({
    publicIp: { value: '1.2.3.4' },
    gatewayUrl: { value: 'https://gw.example.com' },
  })
  mockDestroy.mockResolvedValue(undefined)

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
