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

    expect(streamSpy).toHaveBeenCalledWith(expect.stringContaining('backup create'))
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
  it('requires --file for restore', async () => {
    const { buildContext, acquireSession } = await getMocks()
    buildContext.mockReturnValue(makeLocalFakeContext(FAKE_LOCAL_STATE))
    acquireSession.mockResolvedValue({ session: new FakeSshSession(), release: vi.fn() })

    const cmd = await getCmd()
    await expect(
      (cmd.run as AnyRunFn)({ args: { action: 'restore', yes: true } }),
    ).rejects.toThrow('--file is required')
  })

  it('prompts for confirmation without --yes', async () => {
    const session = new FakeSshSession()
    session.onStream(() => Readable.from([]))

    const { buildContext, acquireSession } = await getMocks()
    buildContext.mockReturnValue(makeLocalFakeContext(FAKE_LOCAL_STATE))
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const cmd = await getCmd()
    await (cmd.run as AnyRunFn)({ args: { action: 'restore', file: '/tmp/backup.tar.gz' } })

    expect(mockQuestion).toHaveBeenCalledOnce()
  })

  it('cancels without streaming when user declines', async () => {
    mockQuestion.mockResolvedValue('n')

    const session = new FakeSshSession()
    const streamSpy = vi.fn()
    vi.spyOn(session, 'stream').mockImplementation(streamSpy)

    const { buildContext, acquireSession } = await getMocks()
    buildContext.mockReturnValue(makeLocalFakeContext(FAKE_LOCAL_STATE))
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const cmd = await getCmd()
    await (cmd.run as AnyRunFn)({ args: { action: 'restore', file: '/tmp/backup.tar.gz' } })

    expect(streamSpy).not.toHaveBeenCalled()
  })

  it('streams restore when --yes is given', async () => {
    const session = new FakeSshSession()
    const streamSpy = vi.fn().mockResolvedValue(Readable.from([]))
    session.onStream(streamSpy)

    const { buildContext, acquireSession } = await getMocks()
    buildContext.mockReturnValue(makeLocalFakeContext(FAKE_LOCAL_STATE))
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const cmd = await getCmd()
    await (cmd.run as AnyRunFn)({ args: { action: 'restore', file: '/tmp/backup.tar.gz', yes: true } })

    expect(streamSpy).toHaveBeenCalledWith(expect.stringContaining('restore'))
  })
})

describe('backup command — validation', () => {
  it('throws for unknown action', async () => {
    const { buildContext, acquireSession } = await getMocks()
    buildContext.mockReturnValue(makeLocalFakeContext(FAKE_LOCAL_STATE))
    acquireSession.mockResolvedValue({ session: new FakeSshSession(), release: vi.fn() })

    const cmd = await getCmd()
    await expect(
      (cmd.run as AnyRunFn)({ args: { action: 'upload' } }),
    ).rejects.toThrow('Unknown action')
  })

  it('exits when local state is missing', async () => {
    const { buildContext } = await getMocks()
    buildContext.mockReturnValue(makeLocalFakeContext(null))
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit') })

    const cmd = await getCmd()
    await expect(
      (cmd.run as AnyRunFn)({ args: { action: 'create' } }),
    ).rejects.toThrow('exit')
    expect(exitSpy).toHaveBeenCalledWith(4)
  })
})
