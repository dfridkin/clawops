// Unit tests for the `agents` command (list / logs; restart was removed in 2.0).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FakeSshSession } from '../helpers/ssh.js'
import { makeFakeContext } from '../helpers/context.js'

vi.mock('../../src/cli/context.js', () => ({ buildContext: vi.fn() }))
vi.mock('../../src/transport/pool.js', () => ({
  acquireSession: vi.fn(),
  drainPool: vi.fn(),
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRunFn = (ctx: any) => Promise<void>

async function getCmd() {
  const { default: cmd } = await import('../../src/cli/commands/agents.js')
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

function wireSession(session: FakeSshSession) {
  return async (_opts: unknown) => ({ session, release: vi.fn() })
}

const SAMPLE_AGENTS = JSON.stringify([
  { name: 'claude', status: 'running' },
  { name: 'gpt', status: 'stopped' },
])

describe('agents command', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  describe('list', () => {
    it('renders agent table from JSON output', async () => {
      const session = new FakeSshSession()
      session.onExec(() => ({ stdout: SAMPLE_AGENTS, stderr: '', code: 0 }))

      const { buildContext, acquireSession } = await getMocks()
      buildContext.mockReturnValue(makeFakeContext())
      acquireSession.mockImplementation(wireSession(session))

      const writes: string[] = []
      vi.spyOn(process.stdout, 'write').mockImplementation((s) => { writes.push(String(s)); return true })

      const cmd = await getCmd()
      await (cmd.run as AnyRunFn)({ args: { _: ['list'], stack: undefined, json: false } })

      const output = writes.join('')
      expect(output).toContain('claude')
      expect(output).toContain('running')
    })

    it('emits JSON envelope with --json flag', async () => {
      const session = new FakeSshSession()
      session.onExec(() => ({ stdout: SAMPLE_AGENTS, stderr: '', code: 0 }))

      const { buildContext, acquireSession } = await getMocks()
      buildContext.mockReturnValue(makeFakeContext())
      acquireSession.mockImplementation(wireSession(session))

      const writes: string[] = []
      vi.spyOn(process.stdout, 'write').mockImplementation((s) => { writes.push(String(s)); return true })

      const cmd = await getCmd()
      await (cmd.run as AnyRunFn)({ args: { _: ['list'], stack: undefined, json: true } })

      const parsed = JSON.parse(writes.join('')) as { ok: boolean; data: unknown[] }
      expect(parsed.ok).toBe(true)
      expect(Array.isArray(parsed.data)).toBe(true)
      expect(parsed.data).toHaveLength(2)
    })

    it('sends docker exec command to list agents', async () => {
      const execCommands: string[] = []
      const session = new FakeSshSession()
      session.onExec((cmd) => { execCommands.push(cmd); return { stdout: '[]', stderr: '', code: 0 } })

      const { buildContext, acquireSession } = await getMocks()
      buildContext.mockReturnValue(makeFakeContext())
      acquireSession.mockImplementation(wireSession(session))

      vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

      const cmd = await getCmd()
      await (cmd.run as AnyRunFn)({ args: { _: ['list'], stack: undefined, json: false } })

      expect(execCommands[0]).toContain('docker exec openclaw')
      expect(execCommands[0]).toContain('agents list --json')
    })

    it('reports a failed listing rather than printing "No agents running."', async () => {
      // `|| echo '[]'` plus a catch that fell back to an empty array turned every failure
      // — stopped container, gateway still starting, docker permission denied — into the
      // same reassuring line.
      const session = new FakeSshSession()
      session.onExec(() => ({ stdout: '', stderr: 'Error: No such container: openclaw', code: 1 }))

      const { buildContext, acquireSession } = await getMocks()
      buildContext.mockReturnValue(makeFakeContext())
      acquireSession.mockImplementation(wireSession(session))

      const writes: string[] = []
      const errors: string[] = []
      vi.spyOn(process.stdout, 'write').mockImplementation((s) => { writes.push(String(s)); return true })
      vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a.join(' ')) })

      const cmd = await getCmd()
      await (cmd.run as AnyRunFn)({ args: { _: ['list'], stack: undefined, json: false } })

      expect(errors.join(' ')).toMatch(/Cannot list agents/)
      expect(errors.join(' ')).toMatch(/No such container/)
      expect(writes.join('')).not.toContain('No agents running')
      expect(process.exitCode).toBe(1)
      process.exitCode = 0
    })

    it('fails on output that is not JSON instead of showing an empty list', async () => {
      const session = new FakeSshSession()
      session.onExec(() => ({ stdout: 'Usage: openclaw agents [command]', stderr: '', code: 0 }))

      const { buildContext, acquireSession } = await getMocks()
      buildContext.mockReturnValue(makeFakeContext())
      acquireSession.mockImplementation(wireSession(session))

      const writes: string[] = []
      const errors: string[] = []
      vi.spyOn(process.stdout, 'write').mockImplementation((s) => { writes.push(String(s)); return true })
      vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a.join(' ')) })

      const cmd = await getCmd()
      await (cmd.run as AnyRunFn)({ args: { _: ['list'], stack: undefined, json: false } })

      expect(errors.join(' ')).toMatch(/Cannot list agents/)
      expect(writes.join('')).not.toContain('No agents running')
      expect(process.exitCode).toBe(1)
      process.exitCode = 0
    })

    it('still says "No agents running." when there really are none', async () => {
      const session = new FakeSshSession()
      session.onExec(() => ({ stdout: '[]', stderr: '', code: 0 }))

      const { buildContext, acquireSession } = await getMocks()
      buildContext.mockReturnValue(makeFakeContext())
      acquireSession.mockImplementation(wireSession(session))

      const infos: string[] = []
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      vi.spyOn(console, 'log').mockImplementation((...a) => { infos.push(a.join(' ')) })

      const cmd = await getCmd()
      await (cmd.run as AnyRunFn)({ args: { _: ['list'], stack: undefined, json: false } })

      expect(infos.join(' ')).toMatch(/No agents running/)
      expect(process.exitCode).not.toBe(1)
    })

    it('does not silence stderr in the command it runs', async () => {
      const execCommands: string[] = []
      const session = new FakeSshSession()
      session.onExec((cmd) => { execCommands.push(cmd); return { stdout: '[]', stderr: '', code: 0 } })

      const { buildContext, acquireSession } = await getMocks()
      buildContext.mockReturnValue(makeFakeContext())
      acquireSession.mockImplementation(wireSession(session))
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

      const cmd = await getCmd()
      await (cmd.run as AnyRunFn)({ args: { _: ['list'], stack: undefined, json: false } })

      // 2>/dev/null threw away the only explanation of why the listing failed.
      expect(execCommands[0]).not.toContain('2>/dev/null')
      expect(execCommands[0]).not.toContain("echo '[]'")
    })
  })

  describe('restart (removed)', () => {
    it('refuses with an explanation instead of restarting the whole gateway', async () => {
      // OpenClaw 2.0 has no per-agent restart. The only restart it offers is
      // gateway-wide and drops every agent on the host, so this exits rather than
      // quietly doing something larger than the command name promises.
      const execCommands: string[] = []
      const session = new FakeSshSession()
      session.onExec((cmd) => { execCommands.push(cmd); return { stdout: '', stderr: '', code: 0 } })

      const { buildContext, acquireSession } = await getMocks()
      buildContext.mockReturnValue(makeFakeContext())
      acquireSession.mockImplementation(wireSession(session))

      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('exit')
      }) as never)
      const errs: string[] = []
      const stderr = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
        errs.push(a.map(String).join(' '))
      })

      const cmd = await getCmd()
      await expect(
        (cmd.run as AnyRunFn)({ args: { _: ['restart'], stack: undefined, json: false } }),
      ).rejects.toThrow('exit')

      expect(exit).toHaveBeenCalledWith(2)
      const text = errs.join('')
      expect(text).toMatch(/removed in clawops 2\.0/)
      expect(text).toMatch(/clawops gateway restart/)
      // The point of the removal: it must not reach the host at all.
      expect(execCommands).toEqual([])

      exit.mockRestore(); stderr.mockRestore()
    })
  })

  describe('logs', () => {
    // OpenClaw 2.0 removed `agents logs`, so the streamed `docker exec -t openclaw openclaw
    // agents logs <name> --follow` this used to run does not exist on any supported gateway.
    // Agent-scoped records come from the audit log now, which is a paged query rather than a
    // stream.
    const PAGE = JSON.stringify({
      records: [
        { at: '2026-09-10T04:00:00Z', status: 'succeeded', summary: 'ran a thing' },
        { at: '2026-09-10T04:01:00Z', status: 'failed', summary: 'did not' },
      ],
      cursor: 'abc123',
    })

    function wire(session: FakeSshSession) {
      return async () => {
        const { buildContext, acquireSession } = await getMocks()
        buildContext.mockReturnValue(makeFakeContext())
        acquireSession.mockImplementation(wireSession(session))
      }
    }

    it('reads the agent audit log, not the removed agents-logs command', async () => {
      const session = new FakeSshSession().respond(/audit/, { stdout: PAGE })
      await wire(session)()
      const written: string[] = []
      vi.spyOn(process.stdout, 'write').mockImplementation((s) => { written.push(String(s)); return true })

      const cmd = await getCmd()
      await (cmd.run as AnyRunFn)({ args: { _: ['logs', 'claude'], stack: undefined, json: false } })

      const call = session.execCalls().find((c) => c.includes('audit'))!
      expect(call).toContain('openclaw audit')
      expect(call).toContain("--agent 'claude'")
      expect(call).toContain('--kind agent_run')
      expect(call).toContain('--json')
      expect(session.execCalls().join(' ')).not.toContain('agents logs')
      expect(written.join('')).toContain('ran a thing')
    })

    it('offers the cursor to continue, rather than pretending to follow', async () => {
      // `openclaw audit` is a paged query. Presenting a poll loop as `--follow` would be a
      // different thing wearing the old command's clothes.
      const session = new FakeSshSession().respond(/audit/, { stdout: PAGE })
      await wire(session)()
      const logs: string[] = []
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      vi.spyOn(console, 'log').mockImplementation((...a) => { logs.push(a.join(' ')) })

      const cmd = await getCmd()
      await (cmd.run as AnyRunFn)({ args: { _: ['logs', 'claude'], stack: undefined, json: false } })

      expect(logs.join(' ')).toContain('--cursor abc123')
      expect(session.execCalls().join(' ')).not.toContain('--follow')
    })

    it('passes --limit and --cursor through', async () => {
      const session = new FakeSshSession().respond(/audit/, { stdout: PAGE })
      await wire(session)()
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      vi.spyOn(console, 'log').mockImplementation(() => {})

      const cmd = await getCmd()
      await (cmd.run as AnyRunFn)({
        args: { _: ['logs', 'claude'], stack: undefined, json: false, limit: '5', cursor: 'zz' },
      })

      const call = session.execCalls().find((c) => c.includes('audit'))!
      expect(call).toContain('--limit 5')
      expect(call).toContain("--cursor 'zz'")
    })

    it('reports a failed query instead of showing nothing', async () => {
      const session = new FakeSshSession().respond(/audit/, { stderr: 'no such agent', code: 1 })
      await wire(session)()
      const errors: string[] = []
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a.join(' ')) })

      const cmd = await getCmd()
      await (cmd.run as AnyRunFn)({ args: { _: ['logs', 'ghost'], stack: undefined, json: false } })

      expect(errors.join(' ')).toMatch(/Cannot read activity/)
      expect(process.exitCode).toBe(1)
      process.exitCode = 0
    })

    it('says so when an agent has no recorded activity', async () => {
      const session = new FakeSshSession().respond(/audit/, { stdout: '{"records":[]}' })
      await wire(session)()
      const logs: string[] = []
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      vi.spyOn(console, 'log').mockImplementation((...a) => { logs.push(a.join(' ')) })

      const cmd = await getCmd()
      await (cmd.run as AnyRunFn)({ args: { _: ['logs', 'quiet'], stack: undefined, json: false } })

      expect(logs.join(' ')).toMatch(/No recorded activity/)
    })

    it('exits with code 2 when logs is called without a name', async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => { throw new Error(`exit:${_code}`) })
      const { buildContext } = await getMocks()
      buildContext.mockReturnValue(makeFakeContext())

      const cmd = await getCmd()
      await expect(
        (cmd.run as AnyRunFn)({ args: { _: ['logs'], stack: undefined, json: false } })
      ).rejects.toThrow('exit:2')

      exitSpy.mockRestore()
    })
  })
})
