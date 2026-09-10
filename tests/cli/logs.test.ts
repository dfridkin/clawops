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
    // The probe runs first, so a single queued handler would answer it and leave the log
    // command unanswered — match on the command instead.
    const session = new FakeSshSession()
      .respond(/openclaw logs/, { stdout: 'log line 1\nlog line 2\n' })
      .respond(/openclaw logs --limit 1 >/, { stdout: 'ok' })

    const { buildContext, acquireSession } = await getMocks()
    buildContext.mockReturnValue(makeFakeContext())
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const cmd = await getCmd()
    await (cmd.run as AnyRunFn)({ args: {} })

    const stdoutCalls = vi.mocked(process.stdout.write).mock.calls.map(c => String(c[0]))
    expect(stdoutCalls.some(s => s.includes('log line 1'))).toBe(true)
  })

  it('passes the tail count to the gateway log command', async () => {
    const session = new FakeSshSession().respond(/openclaw logs --limit 1 >/, { stdout: 'ok' })

    const { buildContext, acquireSession } = await getMocks()
    buildContext.mockReturnValue(makeFakeContext())
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const cmd = await getCmd()
    await (cmd.run as AnyRunFn)({ args: { tail: '20' } })

    expect(session.execCalls().some((c) => c.includes('openclaw logs --limit 20'))).toBe(true)
  })

  it('serves --since from container output, which is the source that has it', async () => {
    // `openclaw logs` has no --since; honouring it from the gateway would silently ignore
    // the window the operator asked for.
    const session = new FakeSshSession()

    const { buildContext, acquireSession } = await getMocks()
    buildContext.mockReturnValue(makeFakeContext())
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const cmd = await getCmd()
    await (cmd.run as AnyRunFn)({ args: { since: '5m' } })

    const call = session.execCalls().find((c) => c.includes('docker logs'))!
    expect(call).toContain("--since '5m'")
    // And it does not probe a gateway it has already decided not to use.
    expect(session.execCalls().some((c) => c.includes('--limit 1 >'))).toBe(false)
  })

  it('never runs journalctl — only the local provider has that unit', async () => {
    // Both this command and the MCP tool ran `journalctl -u openclaw || docker logs`, so on
    // every cloud VM the fallback won and nothing said which source had answered.
    const session = new FakeSshSession().respond(/openclaw logs --limit 1 >/, { stdout: 'ok' })
    const { buildContext, acquireSession } = await getMocks()
    buildContext.mockReturnValue(makeFakeContext())
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const cmd = await getCmd()
    await (cmd.run as AnyRunFn)({ args: {} })

    expect(session.execCalls().join(' ')).not.toContain('journalctl')
  })

  it('falls back to container output when the gateway is not answering, and says which', async () => {
    const session = new FakeSshSession()
      .respond(/docker logs/, { stdout: 'container line\n' })
      .respond(/openclaw logs --limit 1 >/, { stdout: 'no' })
    const { buildContext, acquireSession } = await getMocks()
    buildContext.mockReturnValue(makeFakeContext())
    acquireSession.mockResolvedValue({ session, release: vi.fn() })
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...a) => { logs.push(a.join(' ')) })

    const cmd = await getCmd()
    await (cmd.run as AnyRunFn)({ args: {} })

    expect(logs.join(' ')).toMatch(/container/)
    expect(logs.join(' ')).toMatch(/not answering/)
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
