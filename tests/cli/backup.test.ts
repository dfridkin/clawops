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
  // v1.7.5 made restore throw, because OpenClaw 2026.7.1-2 had no restore subcommand to
  // call. 2.0 does — and it restores into a fresh directory, refusing a non-empty target.
  // clawops delegates rather than extracting archives itself: writing an archive over a
  // live state directory is how a backup becomes corruption.

  const RESTORE_JSON = JSON.stringify({
    ok: true,
    entryCount: 10,
    targetPath: '/tmp/clawops-restored-1',
    warnings: [
      'Restoring an archive is time travel: every restored state surface rolls back to the archive timestamp.',
      'Plugin node_modules are not archived; after activation, run `openclaw plugins update <id>`.',
    ],
  })

  it('delegates to openclaw, into a fresh staging directory', async () => {
    const { writeFileSync, mkdtempSync } = await import('node:fs')
    const { join } = await import('node:path')
    const os = await import('node:os')
    const dir = mkdtempSync(join(os.tmpdir(), 'clawops-restore-test-'))
    const archive = join(dir, 'b.tar.gz')
    writeFileSync(archive, 'archive-bytes')

    const cmds: string[] = []
    const session = new FakeSshSession()
    session.onExec(function handler(cmd: string) {
      cmds.push(cmd)
      session.onExec(handler)
      if (cmd.includes('backup restore')) return { stdout: RESTORE_JSON, stderr: '', code: 0 }
      return { stdout: '', stderr: '', code: 0 }
    })

    const { buildContext, acquireSession } = await getMocks()
    buildContext.mockReturnValue(makeLocalFakeContext(FAKE_LOCAL_STATE))
    acquireSession.mockResolvedValue({ session, release: vi.fn() })
    const writes: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((c) => { writes.push(String(c)); return true })

    const cmd = await getCmd()
    await (cmd.run as AnyRunFn)({ args: { action: 'restore', file: archive, yes: true } })

    // The archive is uploaded through the privileged path, not extracted locally.
    expect(session.inputCalls.length, 'expected the archive to be uploaded').toBe(1)
    // This file mocks node:fs, so createReadStream yields a canned stream rather than the
    // bytes written above — asserting a real file size here can never match, which is how
    // the first version of this assertion went wrong.
    //
    // What matters is the contract: the ARCHIVE THE USER NAMED is the file that gets read
    // and piped to the upload. Asserting the canned payload's length alone would pass even
    // if the command opened a different path entirely.
    const { createReadStream } = await import('node:fs')
    expect(vi.mocked(createReadStream)).toHaveBeenCalledWith(archive)
    expect(session.inputCalls[0]!.bytes).toBeGreaterThan(0)

    const restore = cmds.find((c) => c.includes('backup restore'))
    expect(restore).toBeDefined()
    // --target, so upstream's "must be empty" guard applies; never in place.
    expect(restore).toMatch(/--target \/tmp\/clawops-restored-/)
    expect(restore).toContain('--json')
    // clawops does not untar anything itself.
    // An invocation, not the substring in "restore.tar.gz" — which is what a bare
    // \btar\b matched on the first attempt.
    expect(cmds.some((c) => /(^|[\s;&|])tar\s/.test(c))).toBe(false)
  })

  it('surfaces the restore warnings verbatim', async () => {
    // They describe consequences clawops cannot judge for the operator — rolled-back
    // approvals, channel credentials needing relink, plugins not carried in the archive.
    // Summarising them would lose exactly the detail that matters.
    const { writeFileSync, mkdtempSync } = await import('node:fs')
    const { join } = await import('node:path')
    const os = await import('node:os')
    const dir = mkdtempSync(join(os.tmpdir(), 'clawops-restore-test-'))
    const archive = join(dir, 'b.tar.gz')
    writeFileSync(archive, 'x')

    const session = new FakeSshSession()
    session.onExec(function handler(cmd: string) {
      session.onExec(handler)
      if (cmd.includes('backup restore')) return { stdout: RESTORE_JSON, stderr: '', code: 0 }
      return { stdout: '', stderr: '', code: 0 }
    })
    const { buildContext, acquireSession } = await getMocks()
    buildContext.mockReturnValue(makeLocalFakeContext(FAKE_LOCAL_STATE))
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const out: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((c) => { out.push(String(c)); return true })
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')) })
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')) })

    const cmd = await getCmd()
    await (cmd.run as AnyRunFn)({ args: { action: 'restore', file: archive, yes: true } })

    const text = out.join('\n')
    expect(text).toMatch(/time travel/)
    expect(text).toMatch(/Plugin node_modules are not archived/)
    // And it must not imply the restore is live.
    expect(text).toMatch(/Nothing has been activated/)
  })

  it('requires an archive to restore from', async () => {
    const { buildContext, acquireSession } = await getMocks()
    buildContext.mockReturnValue(makeLocalFakeContext(FAKE_LOCAL_STATE))
    acquireSession.mockResolvedValue({ session: new FakeSshSession(), release: vi.fn() })
    const cmd = await getCmd()
    await expect(
      (cmd.run as AnyRunFn)({ args: { action: 'restore', yes: true } }),
    ).rejects.toThrow(/--file/)
  })
})
