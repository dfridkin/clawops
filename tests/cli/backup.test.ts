import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Readable } from 'node:stream'
import { FakeSshSession } from '../helpers/ssh.js'
import { makeLocalFakeContext, FAKE_LOCAL_STATE } from '../helpers/context.js'
vi.mock('../../src/cli/context.js', () => ({ buildContext: vi.fn() }))
vi.mock('../../src/transport/pool.js', () => ({
  acquireSession: vi.fn(),
  drainPool: vi.fn(),
}))
vi.mock('node:stream/promises', () => ({ pipeline: vi.fn().mockResolvedValue(undefined) }))
vi.mock('node:fs', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs')>()
  return {
    ...orig,
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    createWriteStream: vi.fn(() => new (require('node:stream').Writable)({ write(_c: unknown, _e: unknown, cb: () => void) { cb() } })),
    createReadStream: vi.fn(() => Readable.from(['backup-data'])),
  }
})

const mockQuestion = vi.fn()
const mockClose = vi.fn()
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({ question: mockQuestion, close: mockClose })),
}))

async function getCmd() {
  const { default: cmd } = await import('../../src/cli/commands/backup.js')
  return cmd
}

async function getMocks() {
  const { buildContext } = await import('../../src/cli/context.js')
  const { acquireSession } = await import('../../src/transport/pool.js')
  return {
    buildContext: vi.mocked(buildContext),
    acquireSession: vi.mocked(acquireSession),
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRunFn = (ctx: any) => Promise<void>

beforeEach(() => {
  vi.resetModules()
  mockQuestion.mockResolvedValue('y')
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(process, 'on').mockReturnValue(process)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('backup command — create', () => {
  it('calls session.stream with the backup command', async () => {
    const session = new FakeSshSession()
    const streamSpy = vi.fn().mockResolvedValue(Readable.from(['backup-data']))
    session.onStream(streamSpy)

    const { buildContext, acquireSession } = await getMocks()
    buildContext.mockReturnValue(makeLocalFakeContext(FAKE_LOCAL_STATE))
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const cmd = await getCmd()
    await (cmd.run as AnyRunFn)({ args: { action: 'create', out: '/tmp/test-backup.tar.gz' } })

    // The archive is written to a path inside the container and streamed out with
    // `cat`. `openclaw backup create` has no stdout mode — the previous version
    // invoked `openclaw-ctl backup create --stdout`, where neither the binary nor
    // the flag exists, so it never produced a backup.
    const execCmds = session.execCalls().join('\n')
    expect(execCmds).toContain('openclaw backup create --output')
    expect(execCmds).not.toContain('openclaw-ctl')
    expect(session.streamCalls().join('\n')).toContain('cat /tmp/clawops-backup.tar.gz')
  })

  it('removes the archive from the container afterwards', async () => {
    const session = new FakeSshSession()
    session.onStream(() => Readable.from(['data']))

    const { buildContext, acquireSession } = await getMocks()
    buildContext.mockReturnValue(makeLocalFakeContext(FAKE_LOCAL_STATE))
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const cmd = await getCmd()
    await (cmd.run as AnyRunFn)({ args: { action: 'create', out: '/tmp/b.tar.gz' } })

    expect(session.execCalls().join('\n')).toContain('rm -f /tmp/clawops-backup.tar.gz')
  })

  it('uses default output path when --out is not provided', async () => {
    const session = new FakeSshSession()
    session.onStream(() => Readable.from(['data']))

    const { buildContext, acquireSession } = await getMocks()
    buildContext.mockReturnValue(makeLocalFakeContext(FAKE_LOCAL_STATE))
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const { pipeline } = await import('node:stream/promises')
    const cmd = await getCmd()
    await (cmd.run as AnyRunFn)({ args: { action: 'create' } })

    // pipeline called with a write stream (auto-named path)
    expect(vi.mocked(pipeline)).toHaveBeenCalledOnce()
  })
})

describe('backup command — restore', () => {
  it('refuses, because OpenClaw <= 2026.7.1-2 has no restore subcommand', async () => {
    // 2026.7.1 ships `backup create` and `backup verify` only; restore arrived in
    // OpenClaw 2.0. The previous implementation piped an archive into
    // `openclaw-ctl backup restore --stdin` — neither the binary nor the subcommand
    // exists, so it silently restored nothing.
    const session = new FakeSshSession()
    const streamSpy = vi.fn().mockResolvedValue(Readable.from(['x']))
    session.onStream(streamSpy)

    const { buildContext, acquireSession } = await getMocks()
    buildContext.mockReturnValue(makeLocalFakeContext(FAKE_LOCAL_STATE))
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const cmd = await getCmd()
    await expect(
      (cmd.run as AnyRunFn)({ args: { action: 'restore', file: '/tmp/b.tar.gz', yes: true } }),
    ).rejects.toThrow(/not available on this clawops release/)

    // and it must not have touched the remote host on the way to failing
    expect(streamSpy).not.toHaveBeenCalled()
  })

  it('names the version that does support restore', async () => {
    const session = new FakeSshSession()
    const { buildContext, acquireSession } = await getMocks()
    buildContext.mockReturnValue(makeLocalFakeContext(FAKE_LOCAL_STATE))
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const cmd = await getCmd()
    await expect(
      (cmd.run as AnyRunFn)({ args: { action: 'restore', file: '/tmp/b.tar.gz', yes: true } }),
    ).rejects.toThrow(/clawops 2\.x/)
  })
})
