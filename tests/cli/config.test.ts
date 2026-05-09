// Unit tests for the `config` command (get / set / unset).

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
  const { default: cmd } = await import('../../src/cli/commands/config.js')
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

const SAMPLE_CONFIG = JSON.stringify({
  meta: { lastTouchedVersion: '2026.4' },
  gateway: { port: 18789, auth: { mode: 'token' } },
  models: {},
  channels: {},
})

function wireSession(session: FakeSshSession) {
  return async (_opts: unknown) => ({ session, release: vi.fn() })
}

describe('config command', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  describe('get', () => {
    it('prints full config when no key given', async () => {
      const session = new FakeSshSession()
      session.onExec(() => ({ stdout: SAMPLE_CONFIG, stderr: '', code: 0 }))

      const { buildContext, acquireSession } = await getMocks()
      buildContext.mockReturnValue(makeFakeContext())
      acquireSession.mockImplementation(wireSession(session))

      const writes: string[] = []
      vi.spyOn(process.stdout, 'write').mockImplementation((s) => { writes.push(String(s)); return true })

      const cmd = await getCmd()
      await (cmd.run as AnyRunFn)({ args: { _: ['get'], stack: undefined, restart: false, json: false } })

      const output = writes.join('')
      expect(output).toContain('"meta"')
      expect(output).toContain('2026.4')
    })

    it('prints nested value when dot-notation key given', async () => {
      const session = new FakeSshSession()
      session.onExec(() => ({ stdout: SAMPLE_CONFIG, stderr: '', code: 0 }))

      const { buildContext, acquireSession } = await getMocks()
      buildContext.mockReturnValue(makeFakeContext())
      acquireSession.mockImplementation(wireSession(session))

      const writes: string[] = []
      vi.spyOn(process.stdout, 'write').mockImplementation((s) => { writes.push(String(s)); return true })

      const cmd = await getCmd()
      await (cmd.run as AnyRunFn)({ args: { _: ['get', 'gateway.auth.mode'], stack: undefined, restart: false, json: false } })

      expect(writes.join('')).toContain('token')
    })

    it('emits JSON envelope when --json flag is set', async () => {
      const session = new FakeSshSession()
      session.onExec(() => ({ stdout: SAMPLE_CONFIG, stderr: '', code: 0 }))

      const { buildContext, acquireSession } = await getMocks()
      buildContext.mockReturnValue(makeFakeContext())
      acquireSession.mockImplementation(wireSession(session))

      const writes: string[] = []
      vi.spyOn(process.stdout, 'write').mockImplementation((s) => { writes.push(String(s)); return true })

      const cmd = await getCmd()
      await (cmd.run as AnyRunFn)({ args: { _: ['get'], stack: undefined, restart: false, json: true } })

      const parsed = JSON.parse(writes.join('')) as { ok: boolean; data: Record<string, unknown> }
      expect(parsed.ok).toBe(true)
      expect(parsed.data).toHaveProperty('meta')
    })
  })

  describe('set', () => {
    it('sends a write command containing base64-encoded JSON', async () => {
      const execCommands: string[] = []
      const session = new FakeSshSession()
      session.onExec((cmd) => { execCommands.push(cmd); return { stdout: SAMPLE_CONFIG, stderr: '', code: 0 } })
      session.onExec((cmd) => { execCommands.push(cmd); return { stdout: '', stderr: '', code: 0 } })

      const { buildContext, acquireSession } = await getMocks()
      buildContext.mockReturnValue(makeFakeContext())
      acquireSession.mockImplementation(wireSession(session))

      const cmd = await getCmd()
      await (cmd.run as AnyRunFn)({ args: { _: ['set', 'gateway.auth.mode', 'none'], stack: undefined, restart: false, json: false } })

      expect(execCommands[0]).toContain('cat /home/clawops/openclaw.json')
      expect(execCommands[1]).toContain('base64 -d')
      expect(execCommands[1]).toContain('openclaw.json')
    })

    it('restarts gateway when --restart flag is set', async () => {
      const execCommands: string[] = []
      const session = new FakeSshSession()
      session.onExec((cmd) => { execCommands.push(cmd); return { stdout: SAMPLE_CONFIG, stderr: '', code: 0 } })
      session.onExec((cmd) => { execCommands.push(cmd); return { stdout: '', stderr: '', code: 0 } })
      session.onExec((cmd) => { execCommands.push(cmd); return { stdout: 'ghcr.io/openclaw/openclaw:stable', stderr: '', code: 0 } })
      session.onExec((cmd) => { execCommands.push(cmd); return { stdout: '', stderr: '', code: 0 } })

      const { buildContext, acquireSession } = await getMocks()
      buildContext.mockReturnValue(makeFakeContext())
      acquireSession.mockImplementation(wireSession(session))

      const cmd = await getCmd()
      await (cmd.run as AnyRunFn)({ args: { _: ['set', 'gateway.auth.mode', 'none'], stack: undefined, restart: true, json: false } })

      expect(execCommands).toHaveLength(4)
      expect(execCommands[3]).toContain('docker run')
    })
  })

  describe('unset', () => {
    it('removes key from config and writes back', async () => {
      const execCommands: string[] = []
      const session = new FakeSshSession()
      session.onExec((cmd) => { execCommands.push(cmd); return { stdout: SAMPLE_CONFIG, stderr: '', code: 0 } })
      session.onExec((cmd) => { execCommands.push(cmd); return { stdout: '', stderr: '', code: 0 } })

      const { buildContext, acquireSession } = await getMocks()
      buildContext.mockReturnValue(makeFakeContext())
      acquireSession.mockImplementation(wireSession(session))

      const cmd = await getCmd()
      await (cmd.run as AnyRunFn)({ args: { _: ['unset', 'models'], stack: undefined, restart: false, json: false } })

      expect(execCommands[0]).toContain('cat /home/clawops/openclaw.json')
      // The written config should not have the 'models' key
      const b64Match = execCommands[1]?.match(/echo '([A-Za-z0-9+/=]+)'/)
      if (b64Match) {
        const decoded = Buffer.from(b64Match[1]!, 'base64').toString('utf-8')
        const parsed = JSON.parse(decoded) as Record<string, unknown>
        expect(parsed).not.toHaveProperty('models')
      }
    })
  })

  describe('usage errors', () => {
    it('exits with code 2 for unknown action', async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => { throw new Error(`exit:${_code}`) })
      const { buildContext } = await getMocks()
      buildContext.mockReturnValue(makeFakeContext())

      const cmd = await getCmd()
      await expect(
        (cmd.run as AnyRunFn)({ args: { _: ['bogus'], stack: undefined, restart: false, json: false } })
      ).rejects.toThrow('exit:2')

      exitSpy.mockRestore()
    })
  })
})
