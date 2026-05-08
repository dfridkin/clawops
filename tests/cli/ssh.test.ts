import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { FakeSshSession, fakeReadable } from '../helpers/ssh.js'
import { makeFakeContext, makeLocalFakeContext, FAKE_LOCAL_STATE } from '../helpers/context.js'

vi.mock('../../src/cli/context.js', () => ({ buildContext: vi.fn() }))
vi.mock('../../src/transport/pool.js', () => ({
  acquireSession: vi.fn(),
  drainPool: vi.fn(),
}))

async function getCmd() {
  const { default: cmd } = await import('../../src/cli/commands/ssh.js')
  return cmd
}

async function getMocks() {
  const { buildContext } = await import('../../src/cli/context.js')
  const { acquireSession, drainPool } = await import('../../src/transport/pool.js')
  return {
    buildContext: vi.mocked(buildContext),
    acquireSession: vi.mocked(acquireSession),
    drainPool: vi.mocked(drainPool),
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRunFn = (ctx: any) => Promise<void>

beforeEach(() => {
  vi.resetModules()
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(process, 'on').mockReturnValue(process)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ssh command — --command flag (cloud path)', () => {
  it('calls session.exec with the given command and exits with its code', async () => {
    const session = new FakeSshSession()
    session.onExec(() => ({ stdout: 'container output\n', stderr: '', code: 0 }))

    const { buildContext, acquireSession } = await getMocks()
    buildContext.mockReturnValue(makeFakeContext())
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit') })
    const cmd = await getCmd()
    await expect(
      (cmd.run as AnyRunFn)({ args: { command: 'docker ps' } }),
    ).rejects.toThrow('exit')

    expect(exitSpy).toHaveBeenCalledWith(0)
    const stdoutCalls = vi.mocked(process.stdout.write).mock.calls.map(c => String(c[0]))
    expect(stdoutCalls.some(s => s.includes('container output'))).toBe(true)
  })

  it('propagates non-zero exit code from remote command', async () => {
    const session = new FakeSshSession()
    session.onExec(() => ({ stdout: '', stderr: 'not found\n', code: 127 }))

    const { buildContext, acquireSession } = await getMocks()
    buildContext.mockReturnValue(makeFakeContext())
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit') })
    const cmd = await getCmd()
    await expect(
      (cmd.run as AnyRunFn)({ args: { command: 'no-such-cmd' } }),
    ).rejects.toThrow('exit')

    expect(exitSpy).toHaveBeenCalledWith(127)
  })
})

describe('ssh command — --command flag (local path)', () => {
  it('uses connection info from localState', async () => {
    const session = new FakeSshSession()
    const execSpy = vi.fn().mockResolvedValue({ stdout: 'ok\n', stderr: '', code: 0 })
    session.onExec(execSpy)

    const { buildContext, acquireSession } = await getMocks()
    buildContext.mockReturnValue(makeLocalFakeContext(FAKE_LOCAL_STATE))
    const acquireMock = acquireSession.mockResolvedValue({ session, release: vi.fn() })

    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit') })
    const cmd = await getCmd()
    await expect(
      (cmd.run as AnyRunFn)({ args: { command: 'id' } }),
    ).rejects.toThrow('exit')

    const opts = acquireMock.mock.calls[0]![0] as { host: string }
    expect(opts.host).toBe(FAKE_LOCAL_STATE.sshHost)
  })

  it('exits when local state is missing', async () => {
    const { buildContext } = await getMocks()
    buildContext.mockReturnValue(makeLocalFakeContext(null))
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit') })

    const cmd = await getCmd()
    await expect(
      (cmd.run as AnyRunFn)({ args: { command: 'id' } }),
    ).rejects.toThrow('exit')
    expect(exitSpy).toHaveBeenCalledWith(4)
  })
})

describe('ssh command — interactive shell (no --command)', () => {
  it('calls session.stream with a shell command', async () => {
    const session = new FakeSshSession()
    session.onStream(() => fakeReadable([]))

    const { buildContext, acquireSession } = await getMocks()
    buildContext.mockReturnValue(makeFakeContext())
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const cmd = await getCmd()
    await (cmd.run as AnyRunFn)({ args: {} })
    // Stream ends immediately via fakeReadable — no hang
  })
})

describe('ssh command — cloud path missing outputs', () => {
  it('exits when stack has no publicIp output', async () => {
    const { buildContext } = await getMocks()
    buildContext.mockReturnValue({
      ...makeFakeContext(),
      adapter: { ...makeFakeContext().adapter, name: 'gcp' as const, getConnectionInfo: vi.fn() },
      getStack: vi.fn().mockResolvedValue({
        outputs: vi.fn().mockResolvedValue({}),
      }),
    })
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit') })

    const cmd = await getCmd()
    await expect(
      (cmd.run as AnyRunFn)({ args: { command: 'id' } }),
    ).rejects.toThrow('exit')
    expect(exitSpy).toHaveBeenCalledWith(4)
  })
})
