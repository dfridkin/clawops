// The fourth guard on config delivery: verify the gateway actually answers after a
// restart. v1.7.2 begins applying config that has never taken effect before, so this
// is what catches whatever the port normalisation and argv pin did not.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { restartGateway } from '../../src/plan/remote-config.js'
import type { SshSession, SshExecResult } from '../../src/transport/ssh.js'

const exec = (stdout: string, code = 0): SshExecResult =>
  ({ stdout, stderr: '', code }) as SshExecResult

/**
 * Fake session that answers the fixed preamble (uname, docker inspect, cat config,
 * the restart itself) and then replies to health probes from a scripted list.
 */
function makeSession(probeAnswers: string[]): { session: SshSession; probes: () => number } {
  let probeCount = 0
  const session = {
    exec: vi.fn(async (cmd: string): Promise<SshExecResult> => {
      if (cmd.includes('uname')) return exec('Linux')
      if (cmd.includes('docker inspect')) return exec('ghcr.io/openclaw/openclaw:2026.7.1')
      if (cmd.includes('cat /home/clawops/openclaw.json')) {
        return exec(JSON.stringify({ gateway: { auth: { token: 'tok' } } }))
      }
      if (cmd.includes('/healthz')) {
        const answer = probeAnswers[Math.min(probeCount, probeAnswers.length - 1)] ?? 'waiting'
        probeCount++
        return exec(answer)
      }
      return exec('')
    }),
  } as unknown as SshSession
  return { session, probes: () => probeCount }
}

afterEach(() => vi.useRealTimers())

describe('restartGateway health gate', () => {
  it('succeeds once the gateway answers', async () => {
    const { session, probes } = makeSession(['ok'])
    await expect(restartGateway(session)).resolves.toBeUndefined()
    expect(probes()).toBe(1)
  })

  it('keeps polling while the gateway is still starting', async () => {
    vi.useFakeTimers()
    const { session, probes } = makeSession(['waiting', 'waiting', 'ok'])
    const pending = restartGateway(session)
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(pending).resolves.toBeUndefined()
    expect(probes()).toBe(3)
  })

  it('fails loudly when the gateway never becomes healthy', async () => {
    vi.useFakeTimers()
    const { session } = makeSession(['waiting'])
    const pending = restartGateway(session)
    const assertion = expect(pending).rejects.toThrow(/did not become healthy/)
    await vi.advanceTimersByTimeAsync(60_000)
    await assertion
  })

  it('names the newly-applied config as a likely cause', async () => {
    // The operator needs to know this restart is the first time their stored config
    // has ever taken effect — otherwise the failure looks inexplicable.
    vi.useFakeTimers()
    const { session } = makeSession(['waiting'])
    const pending = restartGateway(session)
    const assertion = expect(pending).rejects.toThrow(/never applied/)
    await vi.advanceTimersByTimeAsync(60_000)
    await assertion
  })

  it('still surfaces a hard restart failure before probing', async () => {
    const session = {
      exec: vi.fn(async (cmd: string): Promise<SshExecResult> => {
        if (cmd.includes('uname')) return exec('Linux')
        if (cmd.includes('docker inspect')) return exec('ghcr.io/openclaw/openclaw:2026.7.1')
        if (cmd.includes('cat ')) return exec('{}')
        return exec('', 1) // the restart command itself fails
      }),
    } as unknown as SshSession
    await expect(restartGateway(session)).rejects.toThrow(/Gateway restart failed/)
  })

  it('refuses to restart when no container is running', async () => {
    // There is no image to reuse, and the old `|| echo ...:latest` fallback resolved
    // to OpenClaw 2.0 — an unsupported version, applied past the version guard.
    const session = {
      exec: vi.fn(async (cmd: string): Promise<SshExecResult> => {
        if (cmd.includes('uname')) return exec('Linux')
        if (cmd.includes('docker inspect')) return exec('', 1)
        if (cmd.includes('cat ')) return exec('{}')
        return exec('')
      }),
    } as unknown as SshSession
    await expect(restartGateway(session)).rejects.toThrow(/No running OpenClaw container/)
  })
})
