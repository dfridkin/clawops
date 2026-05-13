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

vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>()
  return { ...orig, execSync: vi.fn().mockImplementation(() => { throw new Error('not found') }) }
})

vi.mock('inquirer', () => ({
  default: {
    prompt: vi.fn().mockResolvedValue({ selectedIds: [] }),
  },
}))

async function getCmd() {
  const { default: cmd } = await import('../../src/cli/commands/mcp.js')
  return cmd
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRunFn = (ctx: any) => Promise<void> | void

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('mcp command — root', () => {
  it('prints usage when called with no subcommand', async () => {
    const cmd = await getCmd()
    ;(cmd.run as AnyRunFn)({ args: {} })
    const out = vi.mocked(process.stdout.write).mock.calls.map(c => String(c[0])).join('')
    expect(out).toContain('serve')
    expect(out).toContain('install')
  })
})

describe('mcp serve subcommand', () => {
  it('calls serveMcp with default options', async () => {
    const cmd = await getCmd()
    const serve = cmd.subCommands!['serve'] as { run: AnyRunFn }
    const { serveMcp } = await import('../../src/mcp/server.js')
    await serve.run({ args: {} })
    expect(vi.mocked(serveMcp)).toHaveBeenCalledOnce()
  })

  it('passes port to serveMcp when --http is specified', async () => {
    const cmd = await getCmd()
    const serve = cmd.subCommands!['serve'] as { run: AnyRunFn }
    const { serveMcp } = await import('../../src/mcp/server.js')
    await serve.run({ args: { http: '3333' } })
    expect(vi.mocked(serveMcp)).toHaveBeenCalledWith(
      expect.objectContaining({ port: 3333 }),
    )
  })

  it('passes readOnly when --read-only is specified', async () => {
    const cmd = await getCmd()
    const serve = cmd.subCommands!['serve'] as { run: AnyRunFn }
    const { serveMcp } = await import('../../src/mcp/server.js')
    await serve.run({ args: { 'read-only': true } })
    expect(vi.mocked(serveMcp)).toHaveBeenCalledWith(
      expect.objectContaining({ readOnly: true }),
    )
  })
})

describe('mcp install subcommand', () => {
  it('runs without throwing when no apps are selected', async () => {
    const cmd = await getCmd()
    const install = cmd.subCommands!['install'] as { run: AnyRunFn }
    await expect(install.run({ args: {} })).resolves.not.toThrow()
  })

  it('calls writeFileSync once when one app is selected', async () => {
    const inquirer = (await import('inquirer')).default
    vi.mocked(inquirer.prompt).mockResolvedValueOnce({ selectedIds: ['claude-desktop'] })
    const { writeFileSync } = await import('node:fs')
    const cmd = await getCmd()
    const install = cmd.subCommands!['install'] as { run: AnyRunFn }
    await install.run({ args: {} })
    expect(vi.mocked(writeFileSync)).toHaveBeenCalledOnce()
  })
})
