// clawops_backup_create and clawops_backup_restore: the backup surface an agent drives.
//
// The sequence is the one `clawops backup` runs (src/openclaw/backup-flows.ts), driven here
// against a fake host — never real SSH. What these tests guard is what the MCP surface adds and
// must not lose: nothing restores unconfirmed, nothing resolves a relative path against a working
// directory the server ignores, activation happens only when asked for, and a refusal reads the
// same on both surfaces.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { BackupRestoreInput } from '../../src/mcp/tools/_generated.js'
import { FakeSshSession } from '../helpers/ssh.js'
import { makeLocalFakeContext, FAKE_LOCAL_STATE } from '../helpers/context.js'

const h = vi.hoisted(() => ({
  buildContext: vi.fn(),
  acquireSession: vi.fn(),
  drainPool: vi.fn(),
  restartGateway: vi.fn(),
  waitForGateway: vi.fn(),
}))
vi.mock('../../src/cli/context.js', () => ({ buildContext: h.buildContext }))
vi.mock('../../src/transport/pool.js', () => ({ acquireSession: h.acquireSession, drainPool: h.drainPool }))
vi.mock('../../src/plan/remote-config.js', () => ({ restartGateway: h.restartGateway }))
vi.mock('../../src/openclaw/ready.js', () => ({ waitForGateway: h.waitForGateway }))

const MANIFEST = JSON.stringify({
  schemaVersion: 1,
  archiveRoot: '2026-09-25T20-23-13.773+00-00-openclaw-backup',
  paths: { stateDir: '/home/node/.openclaw' },
})
const RESTORE_JSON = JSON.stringify({
  ok: true,
  entryCount: 10,
  warnings: ['Restoring an archive is time travel: every restored state surface rolls back to the archive timestamp.'],
})

/** A healthy Linux host with plenty of room, answering by command rather than by position. */
function healthyHost(): FakeSshSession {
  return new FakeSshSession()
    .respond(/.*/, { stdout: '', code: 0 })
    .respond(/^uname/, { stdout: 'Linux' })
    .respond(/^df /, { stdout: '99999999' })
    .respond(/backup restore/, { stdout: RESTORE_JSON })
    .respond(/manifest\.json/, { stdout: MANIFEST })
    .respond(/^test -d/, { stdout: 'yes' })
}

function serverWith(opts: { elicitation: boolean; action?: 'accept' | 'decline' }): McpServer {
  return {
    server: {
      getClientCapabilities: () => (opts.elicitation ? { elicitation: {} } : {}),
      elicitInput: vi.fn().mockResolvedValue({ action: opts.action ?? 'accept', content: { confirmed: true } }),
      notification: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as McpServer
}

function text(r: { content?: unknown[] }): string {
  return String((r.content?.[0] as { text?: unknown } | undefined)?.text ?? '')
}

let home: string
let archive: string
let session: FakeSshSession
const prevHome = process.env['CLAWOPS_HOME']

function restoreInput(partial: Partial<BackupRestoreInput> = {}): BackupRestoreInput {
  return { file: archive, activate: false, yes: false, ...partial }
}

beforeEach(() => {
  vi.clearAllMocks()
  home = mkdtempSync(join(tmpdir(), 'clawops-mcp-backup-'))
  process.env['CLAWOPS_HOME'] = home
  archive = join(home, 'in.tar.gz')
  writeFileSync(archive, 'archive-bytes')
  session = healthyHost()
  h.buildContext.mockReturnValue(makeLocalFakeContext(FAKE_LOCAL_STATE))
  h.acquireSession.mockResolvedValue({ session, release: vi.fn() })
  h.restartGateway.mockResolvedValue(undefined)
  h.waitForGateway.mockResolvedValue({ ok: true })
})

afterEach(() => {
  if (prevHome === undefined) delete process.env['CLAWOPS_HOME']
  else process.env['CLAWOPS_HOME'] = prevHome
  vi.restoreAllMocks()
})

describe('clawops_backup_restore — confirmation (R19)', () => {
  it('asks first, and touches nothing when the user declines', async () => {
    const server = serverWith({ elicitation: true, action: 'decline' })
    const { handleBackupRestore } = await import('../../src/mcp/tools/cli/backup.js')
    const r = await handleBackupRestore(restoreInput({ stackName: 'prod', activate: true }), server)

    expect(server.server.elicitInput).toHaveBeenCalledOnce()
    expect(text(r)).toMatch(/Nothing was changed/)
    expect(h.acquireSession).not.toHaveBeenCalled()
    expect(session.inputCalls).toHaveLength(0)
  })

  it('tells a client that cannot be asked to call again with yes: true, and runs nothing', async () => {
    const server = serverWith({ elicitation: false })
    const { handleBackupRestore } = await import('../../src/mcp/tools/cli/backup.js')
    const r = await handleBackupRestore(restoreInput(), server)

    expect(text(r)).toContain('`yes: true`')
    expect(server.server.elicitInput).not.toHaveBeenCalled()
    expect(h.acquireSession).not.toHaveBeenCalled()
  })

  it('names the stack and archive, and says staging-only or activation', async () => {
    const { handleBackupRestore } = await import('../../src/mcp/tools/cli/backup.js')

    const staging = serverWith({ elicitation: true, action: 'decline' })
    await handleBackupRestore(restoreInput({ stackName: 'prod' }), staging)
    const stagingMsg = String(vi.mocked(staging.server.elicitInput).mock.calls[0]![0].message)
    expect(stagingMsg).toContain('"prod"')
    expect(stagingMsg).toContain(archive)
    expect(stagingMsg).toMatch(/staging only/)
    expect(stagingMsg).not.toMatch(/ACTIVATE/)

    const live = serverWith({ elicitation: true, action: 'decline' })
    await handleBackupRestore(restoreInput({ stackName: 'prod', activate: true }), live)
    const liveMsg = String(vi.mocked(live.server.elicitInput).mock.calls[0]![0].message)
    expect(liveMsg).toContain('"prod"')
    expect(liveMsg).toContain(archive)
    expect(liveMsg).toMatch(/ACTIVATE/)
    expect(liveMsg).toMatch(/gateway is stopped/)
  })

  it('does not ask when yes: true was passed', async () => {
    const server = serverWith({ elicitation: true, action: 'decline' })
    const { handleBackupRestore } = await import('../../src/mcp/tools/cli/backup.js')
    const r = await handleBackupRestore(restoreInput({ yes: true }), server)
    expect(server.server.elicitInput).not.toHaveBeenCalled()
    expect(r.isError).toBeFalsy()
    expect(session.inputCalls).toHaveLength(1)
  })
})

describe('absolute paths (R7)', () => {
  it('refuses a relative archive path before asking or connecting', async () => {
    const server = serverWith({ elicitation: true })
    const { handleBackupRestore } = await import('../../src/mcp/tools/cli/backup.js')
    const r = await handleBackupRestore(restoreInput({ file: 'backups/in.tar.gz', yes: true }), server)
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/"file" must be an absolute path/)
    expect(h.acquireSession).not.toHaveBeenCalled()
  })

  it('refuses a relative output path', async () => {
    const { handleBackupCreate } = await import('../../src/mcp/tools/cli/backup.js')
    const r = await handleBackupCreate({ out: 'openclaw.tar.gz' }, serverWith({ elicitation: true }))
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/"out" must be an absolute path/)
    expect(h.acquireSession).not.toHaveBeenCalled()
  })
})

describe('clawops_backup_restore — staging vs activation', () => {
  it('without activate, expands beside the live state and changes nothing live', async () => {
    const { handleBackupRestore } = await import('../../src/mcp/tools/cli/backup.js')
    const r = await handleBackupRestore(restoreInput({ yes: true }), serverWith({ elicitation: true }))

    expect(r.isError).toBeFalsy()
    expect(text(r)).toMatch(/Nothing has been activated/)
    expect(text(r)).toMatch(/time travel/)
    const cmds = session.execCalls()
    expect(cmds.some((c) => c.includes('docker cp openclaw:'))).toBe(true)
    expect(cmds.some((c) => c.startsWith('mv '))).toBe(false)
    expect(h.restartGateway).not.toHaveBeenCalled()
  })

  it('with activate, swaps the state in, restarts, and waits for the gateway', async () => {
    const { handleBackupRestore } = await import('../../src/mcp/tools/cli/backup.js')
    const r = await handleBackupRestore(restoreInput({ yes: true, activate: true }), serverWith({ elicitation: true }))

    expect(r.isError).toBeFalsy()
    expect(text(r)).toContain('The restored state is live and the gateway is answering.')
    expect(text(r)).toMatch(/pre-restore-/)
    expect(session.execCalls().some((c) => c.startsWith("mv '/var/lib/clawops/openclaw' "))).toBe(true)
    expect(h.restartGateway).toHaveBeenCalledOnce()
    expect(h.waitForGateway).toHaveBeenCalledOnce()
  })

  it('reports a rollback as an error, not a success', async () => {
    h.waitForGateway.mockRejectedValue(new Error('gateway did not answer within 180s'))
    const { handleBackupRestore } = await import('../../src/mcp/tools/cli/backup.js')
    const r = await handleBackupRestore(restoreInput({ yes: true, activate: true }), serverWith({ elicitation: true }))
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/The previous state has been put back/)
    expect(text(r)).not.toContain('The restored state is live')
  })
})

describe('refusals read the same on both surfaces', () => {
  it('a host without room for the archive is refused in the CLI\'s words', async () => {
    session.respond(/^df /, { stdout: '0' })

    const { handleBackupRestore } = await import('../../src/mcp/tools/cli/backup.js')
    const r = await handleBackupRestore(restoreInput({ yes: true }), serverWith({ elicitation: true }))
    expect(r.isError).toBe(true)

    vi.spyOn(process, 'on').mockReturnValue(process)
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const { default: cmd } = await import('../../src/cli/commands/backup.js')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- citty's run context is untyped here
    const run = cmd.run as (ctx: any) => Promise<void>
    const cliError = await run({ args: { action: 'restore', file: archive, yes: true } }).then(
      () => undefined,
      (e: unknown) => e as Error,
    )

    expect(cliError?.message).toMatch(/^Not enough free space on the host/)
    expect(text(r)).toBe(cliError?.message)
    // Refused before anything was uploaded, on either surface.
    expect(session.inputCalls).toHaveLength(0)
  })

  it('an archive clawops will not adopt says so, and where it was left', async () => {
    session.respond(/manifest\.json/, { stdout: JSON.stringify({ schemaVersion: 2 }) })
    const { handleBackupRestore } = await import('../../src/mcp/tools/cli/backup.js')
    const r = await handleBackupRestore(restoreInput({ yes: true, activate: true }), serverWith({ elicitation: true }))
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/schemaVersion 2/)
    expect(text(r)).toMatch(/nothing has been changed/)
    expect(h.restartGateway).not.toHaveBeenCalled()
  })
})

describe('clawops_backup_create', () => {
  it('writes a 0600 archive under ~/.clawops/backups when out is omitted', async () => {
    session.onStream(() => Readable.from(['archive-bytes']))
    const { handleBackupCreate } = await import('../../src/mcp/tools/cli/backup.js')
    const r = await handleBackupCreate({}, serverWith({ elicitation: true }))

    expect(r.isError).toBeFalsy()
    const files = readdirSync(join(home, 'backups'))
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^openclaw-backup-.*\.tar\.gz$/)
    const written = join(home, 'backups', files[0]!)
    expect(readFileSync(written, 'utf-8')).toBe('archive-bytes')
    expect(statSync(written).mode & 0o777).toBe(0o600)
    expect(text(r)).toContain(`Backup saved to ${written}`)
    expect(text(r)).toMatch(/Treat it as a credential/)
  })

  it('surfaces a remote failure in the flow\'s words', async () => {
    session.respond(/openclaw backup create/, { code: 1, stderr: 'disk full' })
    const { handleBackupCreate } = await import('../../src/mcp/tools/cli/backup.js')
    const r = await handleBackupCreate({ out: join(home, 'x.tar.gz') }, serverWith({ elicitation: true }))
    expect(r.isError).toBe(true)
    expect(text(r)).toBe('Backup failed on the remote host: disk full')
  })
})
