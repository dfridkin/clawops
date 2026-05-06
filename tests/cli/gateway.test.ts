// Unit tests for the `gateway` command (status / restart / update).

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
  const { default: cmd } = await import('../../src/cli/commands/gateway.js')
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

const DOCKER_INSPECT_OUTPUT = JSON.stringify({
  status: 'running',
  started: '2026-05-05T00:00:00.000Z',
  image: 'ghcr.io/openclaw/openclaw:stable',
})

describe('gateway command', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  describe('status', () => {
    it('renders status table from docker inspect output', async () => {
      const session = new FakeSshSession()
      session.onExec(() => ({ stdout: DOCKER_INSPECT_OUTPUT, stderr: '', code: 0 }))

      const { buildContext, acquireSession } = await getMocks()
      buildContext.mockReturnValue(makeFakeContext())
      acquireSession.mockImplementation(wireSession(session))

      const writes: string[] = []
      vi.spyOn(process.stdout, 'write').mockImplementation((s) => { writes.push(String(s)); return true })

      const cmd = await getCmd()
      await (cmd.run as AnyRunFn)({ args: { _: ['status'], stack: undefined, channel: undefined, json: false } })

      expect(writes.join('')).toContain('running')
    })

    it('emits JSON envelope with --json flag', async () => {
      const session = new FakeSshSession()
      session.onExec(() => ({ stdout: DOCKER_INSPECT_OUTPUT, stderr: '', code: 0 }))

      const { buildContext, acquireSession } = await getMocks()
      buildContext.mockReturnValue(makeFakeContext())
      acquireSession.mockImplementation(wireSession(session))

      const writes: string[] = []
      vi.spyOn(process.stdout, 'write').mockImplementation((s) => { writes.push(String(s)); return true })

      const cmd = await getCmd()
      await (cmd.run as AnyRunFn)({ args: { _: ['status'], stack: undefined, channel: undefined, json: true } })

      const parsed = JSON.parse(writes.join('')) as { ok: boolean; data: Record<string, unknown> }
      expect(parsed.ok).toBe(true)
      expect(parsed.data).toHaveProperty('status', 'running')
    })

    it('handles not-running container gracefully', async () => {
      const session = new FakeSshSession()
      session.onExec(() => ({ stdout: '{"status":"not running","started":"","image":""}', stderr: '', code: 0 }))

      const { buildContext, acquireSession } = await getMocks()
      buildContext.mockReturnValue(makeFakeContext())
      acquireSession.mockImplementation(wireSession(session))

      const writes: string[] = []
      vi.spyOn(process.stdout, 'write').mockImplementation((s) => { writes.push(String(s)); return true })

      const cmd = await getCmd()
      await (cmd.run as AnyRunFn)({ args: { _: ['status'], stack: undefined, channel: undefined, json: false } })

      expect(writes.join('')).toContain('not running')
    })
  })

  describe('restart', () => {
    it('reads current version from docker inspect, then runs docker restart', async () => {
      const execCommands: string[] = []
      const session = new FakeSshSession()
      session.onExec((cmd) => { execCommands.push(cmd); return { stdout: 'ghcr.io/openclaw/openclaw:stable', stderr: '', code: 0 } })
      session.onExec((cmd) => { execCommands.push(cmd); return { stdout: '', stderr: '', code: 0 } })

      const { buildContext, acquireSession } = await getMocks()
      buildContext.mockReturnValue(makeFakeContext())
      acquireSession.mockImplementation(wireSession(session))

      const cmd = await getCmd()
      await (cmd.run as AnyRunFn)({ args: { _: ['restart'], stack: undefined, channel: undefined, json: false } })

      expect(execCommands[0]).toContain('docker inspect openclaw')
      expect(execCommands[1]).toContain('docker run')
      expect(execCommands[1]).toContain('stable')
    })

    it('preserves the image version (not hardcoded to stable)', async () => {
      const execCommands: string[] = []
      const session = new FakeSshSession()
      session.onExec((cmd) => { execCommands.push(cmd); return { stdout: 'ghcr.io/openclaw/openclaw:2026.4.5', stderr: '', code: 0 } })
      session.onExec((cmd) => { execCommands.push(cmd); return { stdout: '', stderr: '', code: 0 } })

      const { buildContext, acquireSession } = await getMocks()
      buildContext.mockReturnValue(makeFakeContext())
      acquireSession.mockImplementation(wireSession(session))

      const cmd = await getCmd()
      await (cmd.run as AnyRunFn)({ args: { _: ['restart'], stack: undefined, channel: undefined, json: false } })

      expect(execCommands[1]).toContain('2026.4.5')
    })
  })

  describe('update', () => {
    it('pulls new image then runs container with new version', async () => {
      const execCommands: string[] = []
      const session = new FakeSshSession()
      session.onExec((cmd) => { execCommands.push(cmd); return { stdout: '', stderr: '', code: 0 } })
      session.onExec((cmd) => { execCommands.push(cmd); return { stdout: '', stderr: '', code: 0 } })

      const { buildContext, acquireSession } = await getMocks()
      buildContext.mockReturnValue(makeFakeContext())
      acquireSession.mockImplementation(wireSession(session))

      const cmd = await getCmd()
      await (cmd.run as AnyRunFn)({ args: { _: ['update', 'dev'], stack: undefined, channel: undefined, json: false } })

      expect(execCommands[0]).toContain('docker pull')
      expect(execCommands[0]).toContain('dev')
      expect(execCommands[1]).toContain('docker run')
      expect(execCommands[1]).toContain('dev')
    })

    it('uses --channel when no positional version given', async () => {
      const execCommands: string[] = []
      const session = new FakeSshSession()
      session.onExec((cmd) => { execCommands.push(cmd); return { stdout: '', stderr: '', code: 0 } })
      session.onExec((cmd) => { execCommands.push(cmd); return { stdout: '', stderr: '', code: 0 } })

      const { buildContext, acquireSession } = await getMocks()
      buildContext.mockReturnValue(makeFakeContext())
      acquireSession.mockImplementation(wireSession(session))

      const cmd = await getCmd()
      await (cmd.run as AnyRunFn)({ args: { _: ['update'], stack: undefined, channel: 'dev', json: false } })

      expect(execCommands[0]).toContain('dev')
    })

    it('defaults to stable when no version or channel given', async () => {
      const execCommands: string[] = []
      const session = new FakeSshSession()
      session.onExec((cmd) => { execCommands.push(cmd); return { stdout: '', stderr: '', code: 0 } })
      session.onExec((cmd) => { execCommands.push(cmd); return { stdout: '', stderr: '', code: 0 } })

      const { buildContext, acquireSession } = await getMocks()
      buildContext.mockReturnValue(makeFakeContext())
      acquireSession.mockImplementation(wireSession(session))

      const cmd = await getCmd()
      await (cmd.run as AnyRunFn)({ args: { _: ['update'], stack: undefined, channel: undefined, json: false } })

      expect(execCommands[0]).toContain('stable')
    })

    it('exits with code 1 when docker pull fails', async () => {
      const session = new FakeSshSession()
      session.onExec(() => ({ stdout: '', stderr: 'manifest unknown', code: 1 }))

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => { throw new Error(`exit:${_code}`) })

      const { buildContext, acquireSession } = await getMocks()
      buildContext.mockReturnValue(makeFakeContext())
      acquireSession.mockImplementation(wireSession(session))

      const cmd = await getCmd()
      await expect(
        (cmd.run as AnyRunFn)({ args: { _: ['update', 'nonexistent'], stack: undefined, channel: undefined, json: false } })
      ).rejects.toThrow('exit:1')

      exitSpy.mockRestore()
    })
  })

  describe('usage errors', () => {
    it('exits with code 2 for unknown action', async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => { throw new Error(`exit:${_code}`) })
      const { buildContext } = await getMocks()
      buildContext.mockReturnValue(makeFakeContext())

      const cmd = await getCmd()
      await expect(
        (cmd.run as AnyRunFn)({ args: { _: ['bogus'], stack: undefined, channel: undefined, json: false } })
      ).rejects.toThrow('exit:2')

      exitSpy.mockRestore()
    })
  })
})
