import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockServeMcp = vi.fn().mockResolvedValue(undefined)
vi.mock('../../src/mcp/server.js', () => ({ serveMcp: mockServeMcp }))
vi.mock('node:fs', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs')>()
  return {
    ...orig,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue('{}'),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  }
})

async function getCmd() {
  const { default: cmd } = await import('../../src/cli/commands/mcp.js')
  return cmd
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRunFn = (ctx: any) => Promise<void>

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('mcp command — serve mode', () => {
  it('calls serveMcp when no install flags are given', async () => {
    const cmd = await getCmd()
    const { serveMcp } = await import('../../src/mcp/server.js')
    await (cmd.run as AnyRunFn)({ args: {} })
    expect(vi.mocked(serveMcp)).toHaveBeenCalledOnce()
  })

  it('passes port to serveMcp when --http is specified', async () => {
    const cmd = await getCmd()
    const { serveMcp } = await import('../../src/mcp/server.js')
    await (cmd.run as AnyRunFn)({ args: { http: '3333' } })
    expect(vi.mocked(serveMcp)).toHaveBeenCalledWith(
      expect.objectContaining({ port: 3333 }),
    )
  })

  it('does not call serveMcp when an install flag is given', async () => {
    const cmd = await getCmd()
    const { serveMcp } = await import('../../src/mcp/server.js')
    await (cmd.run as AnyRunFn)({ args: { claude: true } })
    expect(vi.mocked(serveMcp)).not.toHaveBeenCalled()
  })
})

describe('mcp command — install mode', () => {
  it('writes to stderr after installing for a client', async () => {
    const cmd = await getCmd()
    await (cmd.run as AnyRunFn)({ args: { claude: true } })
    const stderrCalls = vi.mocked(process.stderr.write).mock.calls.map(c => String(c[0]))
    expect(stderrCalls.some(s => s.includes('claude'))).toBe(true)
  })

  it('calls writeFileSync when installing for Claude', async () => {
    const { writeFileSync } = await import('node:fs')
    const cmd = await getCmd()
    await (cmd.run as AnyRunFn)({ args: { claude: true } })
    expect(vi.mocked(writeFileSync)).toHaveBeenCalledOnce()
  })

  it('installs for multiple clients when multiple flags are set', async () => {
    const { writeFileSync } = await import('node:fs')
    const cmd = await getCmd()
    await (cmd.run as AnyRunFn)({ args: { claude: true, cursor: true } })
    expect(vi.mocked(writeFileSync)).toHaveBeenCalledTimes(2)
  })
})
