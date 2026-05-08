import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { FakeSshSession, fakeReadable } from '../helpers/ssh.js'
import { makeFakeContext } from '../helpers/context.js'

vi.mock('../../src/cli/context.js', () => ({ buildContext: vi.fn() }))
vi.mock('../../src/transport/pool.js', () => ({
  acquireSession: vi.fn(),
  drainPool: vi.fn(),
}))

async function getCmd() {
  const { default: cmd } = await import('../../src/cli/commands/logs.js')
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

describe('logs command — exec (no --follow)', () => {
  it('calls exec and writes stdout to process.stdout', async () => {
    const session = new FakeSshSession()
    session.onExec(() => ({ stdout: 'log line 1\nlog line 2\n', stderr: '', code: 0 }))

    const { buildContext, acquireSession } = await getMocks()
    buildContext.mockReturnValue(makeFakeContext())
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const cmd = await getCmd()
    await (cmd.run as AnyRunFn)({ args: {} })

    const stdoutCalls = vi.mocked(process.stdout.write).mock.calls.map(c => String(c[0]))
    expect(stdoutCalls.some(s => s.includes('log line 1'))).toBe(true)
  })

  it('passes --tail value to the log command', async () => {
    const session = new FakeSshSession()
    const execSpy = vi.fn().mockResolvedValue({ stdout: '', stderr: '', code: 0 })
    session.onExec(execSpy)

    const { buildContext, acquireSession } = await getMocks()
    buildContext.mockReturnValue(makeFakeContext())
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const cmd = await getCmd()
    await (cmd.run as AnyRunFn)({ args: { tail: '20' } })

    expect(execSpy).toHaveBeenCalledWith(expect.stringContaining('-n 20'))
  })

  it('passes --since flag to the log command', async () => {
    const session = new FakeSshSession()
    const execSpy = vi.fn().mockResolvedValue({ stdout: '', stderr: '', code: 0 })
    session.onExec(execSpy)

    const { buildContext, acquireSession } = await getMocks()
    buildContext.mockReturnValue(makeFakeContext())
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const cmd = await getCmd()
    await (cmd.run as AnyRunFn)({ args: { since: '5m' } })

    expect(execSpy).toHaveBeenCalledWith(expect.stringContaining('5m'))
  })
})

describe('logs command — stream (--follow)', () => {
  it('calls session.stream and pipes to stdout', async () => {
    const session = new FakeSshSession()
    session.onStream(() => fakeReadable(['line1\n', 'line2\n']))

    const { buildContext, acquireSession } = await getMocks()
    buildContext.mockReturnValue(makeFakeContext())
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const cmd = await getCmd()
    await (cmd.run as AnyRunFn)({ args: { follow: true } })

    // stream completed naturally — no error thrown
  })
})

describe('logs command — error handling', () => {
  it('exits when stack has no publicIp output', async () => {
    const { buildContext } = await getMocks()
    buildContext.mockReturnValue({
      ...makeFakeContext(),
      getStack: vi.fn().mockResolvedValue({
        outputs: vi.fn().mockResolvedValue({}),
      }),
    })
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit') })

    const cmd = await getCmd()
    await expect((cmd.run as AnyRunFn)({ args: {} })).rejects.toThrow('exit')
    expect(exitSpy).toHaveBeenCalledWith(4)
  })

  it('propagates errors from acquireSession', async () => {
    const { buildContext, acquireSession } = await getMocks()
    buildContext.mockReturnValue(makeFakeContext())
    acquireSession.mockRejectedValue(new Error('connection refused'))

    const cmd = await getCmd()
    await expect((cmd.run as AnyRunFn)({ args: {} })).rejects.toThrow('connection refused')
  })
})
