// Unit tests for `clawops monitor` — gatherSnapshot, renderSnapshot, and command edge cases.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FakeSshSession } from '../helpers/ssh.js'
import { makeFakeContext, makeLocalFakeContext, FAKE_LOCAL_STATE } from '../helpers/context.js'

vi.mock('../../src/cli/context.js', () => ({ buildContext: vi.fn() }))
vi.mock('../../src/transport/pool.js', () => ({
  acquireSession: vi.fn(),
  drainPool: vi.fn(),
}))

beforeEach(() => {
  vi.resetModules()
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

const GOOD_INSPECT = 'running|ghcr.io/openclaw/openclaw:stable|2026-01-01T00:00:00Z|0'
const GOOD_STATS   = '45.2MiB / 1.9GiB|0.30%'
const GOOD_HEALTH  = 'ok'
const GOOD_CONFIG  = JSON.stringify({
  meta: { lastTouchedVersion: '2026.4' },
  gateway: { auth: { mode: 'token' } },
})
const GOOD_DISK    = '25% used (5G of 20G)'
const GOOD_LOGS    = 'line 1\nline 2\nline 3'

function makeSession(overrides: Partial<{
  inspect: string; stats: string; health: string; config: string; disk: string; logs: string
}> = {}): FakeSshSession {
  const session = new FakeSshSession()
  session
    .onExec(() => ({ stdout: overrides.inspect ?? GOOD_INSPECT, stderr: '', code: 0 }))
    .onExec(() => ({ stdout: overrides.stats   ?? GOOD_STATS,   stderr: '', code: 0 }))
    .onExec(() => ({ stdout: overrides.health  ?? GOOD_HEALTH,  stderr: '', code: 0 }))
    .onExec(() => ({ stdout: overrides.config  ?? GOOD_CONFIG,  stderr: '', code: 0 }))
    .onExec(() => ({ stdout: overrides.disk    ?? GOOD_DISK,    stderr: '', code: 0 }))
    .onExec(() => ({ stdout: overrides.logs    ?? GOOD_LOGS,    stderr: '', code: 0 }))
  return session
}

// ─── gatherSnapshot ────────────────────────────────────────────────────────────

describe('gatherSnapshot()', () => {
  it('parses a healthy running container', async () => {
    const { gatherSnapshot } = await import('../../src/cli/commands/monitor.js')
    const snap = await gatherSnapshot(makeSession(), new AbortController().signal)

    expect(snap.container.status).toBe('running')
    expect(snap.container.image).toBe('ghcr.io/openclaw/openclaw:stable')
    expect(snap.container.restartCount).toBe(0)
    expect(snap.container.memUsage).toBe('45.2MiB / 1.9GiB')
    expect(snap.container.cpuPct).toBe('0.30%')
  })

  it('reports gateway reachable=true when health endpoint returns ok', async () => {
    const { gatherSnapshot } = await import('../../src/cli/commands/monitor.js')
    const snap = await gatherSnapshot(makeSession(), new AbortController().signal)
    expect(snap.gateway.reachable).toBe(true)
  })

  it('reports gateway reachable=false when health endpoint returns unreachable', async () => {
    const { gatherSnapshot } = await import('../../src/cli/commands/monitor.js')
    const snap = await gatherSnapshot(makeSession({ health: 'unreachable' }), new AbortController().signal)
    expect(snap.gateway.reachable).toBe(false)
  })

  it('extracts version and authMode from openclaw.json', async () => {
    const { gatherSnapshot } = await import('../../src/cli/commands/monitor.js')
    const snap = await gatherSnapshot(makeSession(), new AbortController().signal)
    expect(snap.gateway.version).toBe('2026.4')
    expect(snap.gateway.authMode).toBe('token')
  })

  it('falls back to "unknown" when openclaw.json is missing or invalid', async () => {
    const { gatherSnapshot } = await import('../../src/cli/commands/monitor.js')
    const snap = await gatherSnapshot(makeSession({ config: '{}' }), new AbortController().signal)
    expect(snap.gateway.version).toBe('unknown')
    expect(snap.gateway.authMode).toBe('unknown')
  })

  it('handles container not found gracefully', async () => {
    const { gatherSnapshot } = await import('../../src/cli/commands/monitor.js')
    const snap = await gatherSnapshot(
      makeSession({ inspect: 'not found|||0', stats: '—|—' }),
      new AbortController().signal,
    )
    expect(snap.container.status).toBe('not found')
  })

  it('splits log output into individual lines, filtering blanks', async () => {
    const { gatherSnapshot } = await import('../../src/cli/commands/monitor.js')
    const snap = await gatherSnapshot(makeSession(), new AbortController().signal)
    expect(snap.logLines).toEqual(['line 1', 'line 2', 'line 3'])
  })

  it('includes disk usage string', async () => {
    const { gatherSnapshot } = await import('../../src/cli/commands/monitor.js')
    const snap = await gatherSnapshot(makeSession(), new AbortController().signal)
    expect(snap.disk).toBe('25% used (5G of 20G)')
  })
})

// ─── renderSnapshot ────────────────────────────────────────────────────────────

describe('renderSnapshot()', () => {
  it('includes gateway health status', async () => {
    const { gatherSnapshot, renderSnapshot } = await import('../../src/cli/commands/monitor.js')
    const snap = await gatherSnapshot(makeSession(), new AbortController().signal)
    const out = renderSnapshot(snap, { stackName: 'default', intervalSec: 10, showLogs: false, noColor: true })
    expect(out).toContain('✓ healthy')
  })

  it('shows unreachable when gateway is down', async () => {
    const { gatherSnapshot, renderSnapshot } = await import('../../src/cli/commands/monitor.js')
    const snap = await gatherSnapshot(makeSession({ health: 'unreachable' }), new AbortController().signal)
    const out = renderSnapshot(snap, { stackName: 'default', intervalSec: 10, showLogs: false, noColor: true })
    expect(out).toContain('✗ unreachable')
  })

  it('includes container running status', async () => {
    const { gatherSnapshot, renderSnapshot } = await import('../../src/cli/commands/monitor.js')
    const snap = await gatherSnapshot(makeSession(), new AbortController().signal)
    const out = renderSnapshot(snap, { stackName: 'default', intervalSec: 10, showLogs: false, noColor: true })
    expect(out).toContain('✓ running')
  })

  it('includes log lines when showLogs=true', async () => {
    const { gatherSnapshot, renderSnapshot } = await import('../../src/cli/commands/monitor.js')
    const snap = await gatherSnapshot(makeSession(), new AbortController().signal)
    const out = renderSnapshot(snap, { stackName: 'default', intervalSec: 10, showLogs: true, noColor: true })
    expect(out).toContain('line 1')
    expect(out).toContain('line 2')
  })

  it('omits log lines when showLogs=false', async () => {
    const { gatherSnapshot, renderSnapshot } = await import('../../src/cli/commands/monitor.js')
    const snap = await gatherSnapshot(makeSession(), new AbortController().signal)
    const out = renderSnapshot(snap, { stackName: 'default', intervalSec: 10, showLogs: false, noColor: true })
    expect(out).not.toContain('line 1')
  })

  it('includes stack name in header', async () => {
    const { gatherSnapshot, renderSnapshot } = await import('../../src/cli/commands/monitor.js')
    const snap = await gatherSnapshot(makeSession(), new AbortController().signal)
    const out = renderSnapshot(snap, { stackName: 'prod-us', intervalSec: 10, showLogs: false, noColor: true })
    expect(out).toContain('prod-us')
  })

  it('shows interval in footer', async () => {
    const { gatherSnapshot, renderSnapshot } = await import('../../src/cli/commands/monitor.js')
    const snap = await gatherSnapshot(makeSession(), new AbortController().signal)
    const out = renderSnapshot(snap, { stackName: 'default', intervalSec: 30, showLogs: false, noColor: true })
    expect(out).toContain('interval: 30s')
  })
})

// ─── formatUptime ──────────────────────────────────────────────────────────────

describe('formatUptime()', () => {
  it('returns — for empty string', async () => {
    const { formatUptime } = await import('../../src/cli/commands/monitor.js')
    expect(formatUptime('')).toBe('—')
  })

  it('formats days, hours, minutes', async () => {
    const { formatUptime } = await import('../../src/cli/commands/monitor.js')
    const twoDaysAgo = new Date(Date.now() - (2 * 24 * 60 + 90) * 60 * 1000).toISOString()
    const result = formatUptime(twoDaysAgo)
    expect(result).toMatch(/^2d/)
  })

  it('formats hours and minutes for sub-day uptime', async () => {
    const { formatUptime } = await import('../../src/cli/commands/monitor.js')
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
    expect(formatUptime(threeHoursAgo)).toMatch(/^3h/)
  })
})

// ─── command — edge cases ──────────────────────────────────────────────────────

describe('monitor command', () => {
  it('exits with code 4 when stack has no outputs (cloud)', async () => {
    const { buildContext } = await import('../../src/cli/context.js')
    const { acquireSession } = await import('../../src/transport/pool.js')

    vi.mocked(buildContext).mockReturnValue({
      ...makeFakeContext(),
      getStack: vi.fn().mockResolvedValue({
        outputs: vi.fn().mockResolvedValue({}),
      }),
    } as ReturnType<typeof makeFakeContext>)
    vi.mocked(acquireSession).mockResolvedValue({ session: makeSession(), release: vi.fn() })

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit') }) as never)

    const { default: cmd } = await import('../../src/cli/commands/monitor.js')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((cmd.run as any)({ args: {} })).rejects.toThrow('exit')
    expect(exitSpy).toHaveBeenCalledWith(4)

    exitSpy.mockRestore()
  })

  it('exits with code 4 when local stack is not bootstrapped', async () => {
    const { buildContext } = await import('../../src/cli/context.js')
    vi.mocked(buildContext).mockReturnValue(makeLocalFakeContext(null))

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit') }) as never)

    const { default: cmd } = await import('../../src/cli/commands/monitor.js')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((cmd.run as any)({ args: {} })).rejects.toThrow('exit')
    expect(exitSpy).toHaveBeenCalledWith(4)

    exitSpy.mockRestore()
  })

  it('takes one snapshot and exits cleanly when stdout is not a TTY', async () => {
    const { buildContext } = await import('../../src/cli/context.js')
    const { acquireSession, drainPool } = await import('../../src/transport/pool.js')

    vi.mocked(buildContext).mockReturnValue(makeLocalFakeContext(FAKE_LOCAL_STATE))
    const release = vi.fn()
    vi.mocked(acquireSession).mockResolvedValue({ session: makeSession(), release })

    const writes: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => { writes.push(String(s)); return true })

    // Force non-TTY
    const isTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true })

    try {
      const { default: cmd } = await import('../../src/cli/commands/monitor.js')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (cmd.run as any)({ args: {} })
    } finally {
      if (isTTYDescriptor) Object.defineProperty(process.stdout, 'isTTY', isTTYDescriptor)
    }

    expect(release).toHaveBeenCalled()
    expect(vi.mocked(drainPool)).toHaveBeenCalled()
    expect(writes.some(w => w.includes('Gateway') || w.includes('monitor'))).toBe(true)
  })
})
