// Unit tests for the `agents` command (list / restart / logs).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FakeSshSession, fakeReadable } from '../helpers/ssh.js'
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
  })

  describe('restart', () => {
    it('restarts all agents when no name given', async () => {
      const execCommands: string[] = []
      const session = new FakeSshSession()
      session.onExec((cmd) => { execCommands.push(cmd); return { stdout: '', stderr: '', code: 0 } })

      const { buildContext, acquireSession } = await getMocks()
      buildContext.mockReturnValue(makeFakeContext())
      acquireSession.mockImplementation(wireSession(session))

      const cmd = await getCmd()
      await (cmd.run as AnyRunFn)({ args: { _: ['restart'], stack: undefined, json: false } })

      expect(execCommands[0]).toContain('agents restart')
      // No agent name appended when name is omitted
      expect(execCommands[0]).not.toMatch(/restart\s+\S+$/)
    })

    it('restarts named agent when name is given', async () => {
      const execCommands: string[] = []
      const session = new FakeSshSession()
      session.onExec((cmd) => { execCommands.push(cmd); return { stdout: '', stderr: '', code: 0 } })

      const { buildContext, acquireSession } = await getMocks()
      buildContext.mockReturnValue(makeFakeContext())
      acquireSession.mockImplementation(wireSession(session))

      const cmd = await getCmd()
      await (cmd.run as AnyRunFn)({ args: { _: ['restart', 'claude'], stack: undefined, json: false } })

      expect(execCommands[0]).toContain('agents restart claude')
    })
  })

  describe('logs', () => {
    it('streams logs for named agent to stdout', async () => {
      const session = new FakeSshSession()
      const logChunks = ['line1\n', 'line2\n']
      session.onStream(() => fakeReadable(logChunks))

      const { buildContext, acquireSession } = await getMocks()
      buildContext.mockReturnValue(makeFakeContext())
      acquireSession.mockImplementation(wireSession(session))

      const written: string[] = []
      vi.spyOn(process.stdout, 'write').mockImplementation((s) => { written.push(String(s)); return true })

      const cmd = await getCmd()
      await (cmd.run as AnyRunFn)({ args: { _: ['logs', 'claude'], stack: undefined, json: false } })

      expect(written.join('')).toContain('line1')
    })

    it('sends correct docker exec -t stream command', async () => {
      const streamCommands: string[] = []
      const session = new FakeSshSession()
      session.onStream((cmd) => { streamCommands.push(cmd); return fakeReadable([]) })

      const { buildContext, acquireSession } = await getMocks()
      buildContext.mockReturnValue(makeFakeContext())
      acquireSession.mockImplementation(wireSession(session))

      vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

      const cmd = await getCmd()
      await (cmd.run as AnyRunFn)({ args: { _: ['logs', 'myagent'], stack: undefined, json: false } })

      expect(streamCommands[0]).toContain('docker exec -t openclaw')
      expect(streamCommands[0]).toContain('logs myagent')
      expect(streamCommands[0]).toContain('--follow')
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
