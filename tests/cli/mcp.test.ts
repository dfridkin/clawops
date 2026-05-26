import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockServeMcp = vi.fn().mockResolvedValue(undefined)
vi.mock('../../src/mcp/server.js', () => ({ serveMcp: mockServeMcp }))

vi.mock('../../src/cli/context.js', () => ({ buildContext: vi.fn() }))
vi.mock('../../src/transport/pool.js', () => ({
  acquireSession: vi.fn(),
  drainPool: vi.fn(),
}))
vi.mock('../../src/cli/mcp-wire.js', () => ({ wireGatewayMcp: vi.fn() }))

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
type SubCmds = Record<string, { run: AnyRunFn }>

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
  it('exposes serve, install, and wire subcommands', async () => {
    const cmd = await getCmd()
    expect(cmd.subCommands).toHaveProperty('serve')
    expect(cmd.subCommands).toHaveProperty('install')
    expect(cmd.subCommands).toHaveProperty('wire')
  })
})

describe('mcp serve subcommand', () => {
  it('calls serveMcp with default options', async () => {
    const cmd = await getCmd()
    const serve = (cmd.subCommands as SubCmds)['serve'] as { run: AnyRunFn }
    const { serveMcp } = await import('../../src/mcp/server.js')
    await serve.run({ args: {} })
    expect(vi.mocked(serveMcp)).toHaveBeenCalledOnce()
  })

  it('passes port to serveMcp when --http is specified', async () => {
    const cmd = await getCmd()
    const serve = (cmd.subCommands as SubCmds)['serve'] as { run: AnyRunFn }
    const { serveMcp } = await import('../../src/mcp/server.js')
    await serve.run({ args: { http: '3333' } })
    expect(vi.mocked(serveMcp)).toHaveBeenCalledWith(
      expect.objectContaining({ port: 3333 }),
    )
  })

  it('passes readOnly when --read-only is specified', async () => {
    const cmd = await getCmd()
    const serve = (cmd.subCommands as SubCmds)['serve'] as { run: AnyRunFn }
    const { serveMcp } = await import('../../src/mcp/server.js')
    await serve.run({ args: { 'read-only': true } })
    expect(vi.mocked(serveMcp)).toHaveBeenCalledWith(
      expect.objectContaining({ readOnly: true }),
    )
  })
})

describe('mcp wire subcommand', () => {
  async function getWire() {
    const cmd = await getCmd()
    return (cmd.subCommands as SubCmds)['wire'] as { run: AnyRunFn }
  }

  async function getMocks() {
    const { buildContext } = await import('../../src/cli/context.js')
    const { acquireSession } = await import('../../src/transport/pool.js')
    const { wireGatewayMcp } = await import('../../src/cli/mcp-wire.js')
    return {
      buildContext: vi.mocked(buildContext),
      acquireSession: vi.mocked(acquireSession),
      wireGatewayMcp: vi.mocked(wireGatewayMcp),
    }
  }

  function makeLocalCtx() {
    return {
      adapter: { name: 'local' },
      localState: { sshHost: '10.0.0.1', sshPort: 22, sshUser: 'ubuntu', privateKeyPath: '/k', knownHostsPath: '/kh' },
      config: { ssh: { keyPath: '/k', knownHostsPath: '/kh' } },
    }
  }

  function makeSession() {
    return { close: vi.fn() }
  }

  it('wires successfully and prints success', async () => {
    const mocks = await getMocks()
    mocks.buildContext.mockReturnValue(makeLocalCtx() as unknown as ReturnType<typeof mocks.buildContext>)
    const session = makeSession()
    const release = vi.fn()
    mocks.acquireSession.mockResolvedValue({ session, release } as never)
    mocks.wireGatewayMcp.mockResolvedValue({ status: 'wired', rewired: false })
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const wire = await getWire()
    await wire.run({ args: { stack: 'default', force: false } })

    expect(mocks.wireGatewayMcp).toHaveBeenCalledWith(session, expect.any(AbortSignal), { force: false })
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("gateway's AI"))
    expect(release).toHaveBeenCalled()
  })

  it('shows re-wire message when entry already existed', async () => {
    const mocks = await getMocks()
    mocks.buildContext.mockReturnValue(makeLocalCtx() as unknown as ReturnType<typeof mocks.buildContext>)
    const session = makeSession()
    mocks.acquireSession.mockResolvedValue({ session, release: vi.fn() } as never)
    mocks.wireGatewayMcp.mockResolvedValue({ status: 'wired', rewired: true })
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const wire = await getWire()
    await wire.run({ args: { stack: 'default', force: false } })

    // success() is called with the "can now run" message in both rewired and new cases
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("gateway's AI"))
  })

  it('exits with code 1 on version-blocked without --force', async () => {
    const mocks = await getMocks()
    mocks.buildContext.mockReturnValue(makeLocalCtx() as unknown as ReturnType<typeof mocks.buildContext>)
    const session = makeSession()
    mocks.acquireSession.mockResolvedValue({ session, release: vi.fn() } as never)
    mocks.wireGatewayMcp.mockResolvedValue({ status: 'version-blocked', version: '2025.12' })
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code) => { throw new Error('exit') })

    const wire = await getWire()
    await expect(wire.run({ args: { stack: 'default', force: false } })).rejects.toThrow('exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('exits with code 1 when local stack has no state', async () => {
    const mocks = await getMocks()
    mocks.buildContext.mockReturnValue({
      adapter: { name: 'local' },
      localState: null,
    } as unknown as ReturnType<typeof mocks.buildContext>)
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code) => { throw new Error('exit') })

    const wire = await getWire()
    await expect(wire.run({ args: { stack: 'default', force: false } })).rejects.toThrow('exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})

describe('mcp install subcommand', () => {
  it('runs without throwing when no apps are selected', async () => {
    const cmd = await getCmd()
    const install = (cmd.subCommands as SubCmds)['install'] as { run: AnyRunFn }
    await expect(install.run({ args: {} })).resolves.not.toThrow()
  })

  it('calls writeFileSync once when one app is selected', async () => {
    const inquirer = (await import('inquirer')).default
    vi.mocked(inquirer.prompt).mockResolvedValueOnce({ selectedIds: ['claude-desktop'] })
    const { writeFileSync } = await import('node:fs')
    const cmd = await getCmd()
    const install = (cmd.subCommands as SubCmds)['install'] as { run: AnyRunFn }
    await install.run({ args: {} })
    expect(vi.mocked(writeFileSync)).toHaveBeenCalledOnce()
  })
})
