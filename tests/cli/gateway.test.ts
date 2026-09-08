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
      // Command-driven rather than positional: the restart path makes two inspect calls
      // now (image, then port bindings), and a queue keyed on call order breaks whenever
      // a step is added.
      session.onExec(function handler(cmd: string) {
        execCommands.push(cmd)
        session.onExec(handler)
        if (cmd.includes('PortBindings')) return { stdout: '{"18789/tcp":[{"HostIp":"127.0.0.1"}]}', stderr: '', code: 0 }
        if (cmd.includes('docker inspect')) return { stdout: 'ghcr.io/openclaw/openclaw:stable', stderr: '', code: 0 }
        return { stdout: '', stderr: '', code: 0 }
      })

      const { buildContext, acquireSession } = await getMocks()
      buildContext.mockReturnValue(makeFakeContext())
      acquireSession.mockImplementation(wireSession(session))

      const cmd = await getCmd()
      await (cmd.run as AnyRunFn)({ args: { _: ['restart'], stack: undefined, channel: undefined, json: false } })

      expect(execCommands[0]).toContain('docker inspect openclaw')
      // Second inspect reads the port bindings: a restart preserves reachability as well
      // as version, so it can neither widen nor narrow who may reach the gateway.
      expect(execCommands[1]).toContain('PortBindings')
      expect(execCommands[2]).toContain('docker run')
      expect(execCommands[2]).toContain('stable')
    })

    it('preserves the image version (not hardcoded to stable)', async () => {
      const execCommands: string[] = []
      const session = new FakeSshSession()
      session.onExec(function handler(cmd: string) {
        execCommands.push(cmd)
        session.onExec(handler)
        if (cmd.includes('PortBindings')) return { stdout: '{"18789/tcp":[{"HostIp":"127.0.0.1"}]}', stderr: '', code: 0 }
        if (cmd.includes('docker inspect')) return { stdout: 'ghcr.io/openclaw/openclaw:2026.9.2', stderr: '', code: 0 }
        return { stdout: '', stderr: '', code: 0 }
      })

      const { buildContext, acquireSession } = await getMocks()
      buildContext.mockReturnValue(makeFakeContext())
      acquireSession.mockImplementation(wireSession(session))

      const cmd = await getCmd()
      await (cmd.run as AnyRunFn)({ args: { _: ['restart'], stack: undefined, channel: undefined, json: false } })

      expect(execCommands[2]).toContain('2026.9.2')
    })
  })

  describe('update', () => {
    it('pulls new image then runs container with new version', async () => {
      const execCommands: string[] = []
      const session = new FakeSshSession()
      session.onExec(function handler(cmd: string) {
        execCommands.push(cmd)
        session.onExec(handler)
        if (cmd.includes('PortBindings')) return { stdout: '{"18789/tcp":[{"HostIp":"127.0.0.1"}]}', stderr: '', code: 0 }
        return { stdout: '', stderr: '', code: 0 }
      })

      const { buildContext, acquireSession } = await getMocks()
      buildContext.mockReturnValue(makeFakeContext())
      acquireSession.mockImplementation(wireSession(session))

      const cmd = await getCmd()
      await (cmd.run as AnyRunFn)({ args: { _: ['update', '2026.9.2'], stack: undefined, channel: undefined, json: false } })

      const pull = execCommands.find((c) => c.includes('docker pull'))
      const run = execCommands.find((c) => c.includes('docker run'))
      expect(pull).toContain('2026.9.2')
      // An update changes the version by request; it must not change reachability, so it
      // reads the current port bindings first.
      expect(execCommands.some((c) => c.includes('PortBindings'))).toBe(true)
      expect(run).toContain('2026.9.2')
      expect(run).toContain('127.0.0.1:18789')
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
      await (cmd.run as AnyRunFn)({ args: { _: ['update'], stack: undefined, channel: '2026.9.2', json: false } })

      expect(execCommands[0]).toContain('2026.9.2')
    })

    it('defaults to the supported pin, never a moving tag', async () => {
      const execCommands: string[] = []
      const session = new FakeSshSession()
      session.onExec((cmd) => { execCommands.push(cmd); return { stdout: '', stderr: '', code: 0 } })
      session.onExec((cmd) => { execCommands.push(cmd); return { stdout: '', stderr: '', code: 0 } })

      const { buildContext, acquireSession } = await getMocks()
      buildContext.mockReturnValue(makeFakeContext())
      acquireSession.mockImplementation(wireSession(session))

      const cmd = await getCmd()
      await (cmd.run as AnyRunFn)({ args: { _: ['update'], stack: undefined, channel: undefined, json: false } })

      // Was `stable` — a moving tag handed straight to `docker pull`, which is how an
      // unsupported release reaches a deployment. Now the recommended pin from
      // spec/openclaw-versions.yaml.
      expect(execCommands[0]).toContain('2026.9.2')
      expect(execCommands[0]).not.toContain('stable')
    })

    it('refuses a version the runtime cannot deploy, BEFORE pulling it', async () => {
      // `update` is the only command that changes the deployed version, and it was the
      // only one that did not check it. Guarding after the pull would guard after the
      // damage: the image is on the host and the container is replaced with it.
      const execCommands: string[] = []
      const session = new FakeSshSession()
      session.onExec(function handler(cmd: string) {
        execCommands.push(cmd)
        session.onExec(handler)
        return { stdout: '', stderr: '', code: 0 }
      })
      const { buildContext, acquireSession } = await getMocks()
      buildContext.mockReturnValue(makeFakeContext())
      acquireSession.mockImplementation(wireSession(session))

      const cmd = await getCmd()
      await expect(
        (cmd.run as AnyRunFn)({
          args: { _: ['update', '2026.7.1-2'], stack: undefined, channel: undefined, json: false },
        }),
      ).rejects.toThrow(/older than this clawops release supports|legacy/)

      // Nothing reached the host at all.
      expect(execCommands.filter((c) => c.includes('docker pull'))).toEqual([])
    })

    it('refuses a moving tag rather than resolving it at pull time', async () => {
      // A moving tag passed to `docker pull` is resolved by the registry, after every
      // check clawops could make. That is how the unbounded ceiling survived on 1.x.
      const execCommands: string[] = []
      const session = new FakeSshSession()
      session.onExec(function handler(cmd: string) {
        execCommands.push(cmd)
        session.onExec(handler)
        return { stdout: '', stderr: '', code: 0 }
      })
      const { buildContext, acquireSession } = await getMocks()
      buildContext.mockReturnValue(makeFakeContext())
      acquireSession.mockImplementation(wireSession(session))

      const cmd = await getCmd()
      await expect(
        (cmd.run as AnyRunFn)({
          args: { _: ['update'], stack: undefined, channel: 'stable', json: false },
        }),
      ).rejects.toThrow(/moving tag/)
      expect(execCommands.filter((c) => c.includes('docker pull'))).toEqual([])
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
        (cmd.run as AnyRunFn)({ args: { _: ['update', '2026.9.2'], stack: undefined, channel: undefined, json: false } })
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
