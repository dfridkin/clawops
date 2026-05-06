// Unit tests for SshConnectionPool (acquireSession / release / drainPool / eviction).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Mock ssh.ts connect() ──────────────────────────────────────────────────────
function makeMockSession() {
  return { exec: vi.fn(), stream: vi.fn(), tunnel: vi.fn(), close: vi.fn() }
}

vi.mock('../../src/transport/ssh.js', () => ({
  connect: vi.fn(),
}))

// ── Import after mocks ─────────────────────────────────────────────────────────
import { acquireSession, drainPool } from '../../src/transport/pool.js'
import { connect } from '../../src/transport/ssh.js'

const mockConnect = vi.mocked(connect)

const OPTS = {
  host: '10.0.0.1',
  port: 22,
  user: 'root',
  privateKeyPath: '/tmp/id_ed25519',
  knownHostsPath: '/tmp/known_hosts',
}

const OPTS2 = { ...OPTS, host: '10.0.0.2' }

describe('acquireSession()', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    drainPool() // start each test with an empty pool
  })

  afterEach(() => {
    drainPool()
    vi.useRealTimers()
  })

  it('creates a new connection when pool is empty', async () => {
    mockConnect.mockResolvedValue(makeMockSession() as never)
    const { session, release } = await acquireSession(OPTS)
    expect(mockConnect).toHaveBeenCalledTimes(1)
    expect(session).toBeDefined()
    release()
  })

  it('reuses idle connection on second acquire (connect called only once)', async () => {
    mockConnect.mockResolvedValue(makeMockSession() as never)

    const { session: s1, release: r1 } = await acquireSession(OPTS)
    r1() // mark as idle

    const { session: s2, release: r2 } = await acquireSession(OPTS)
    expect(mockConnect).toHaveBeenCalledTimes(1)
    expect(s2).toBe(s1) // same underlying session object
    r2()
  })

  it('opens a second connection when existing one is in-use', async () => {
    mockConnect.mockResolvedValue(makeMockSession() as never)

    const { release: r1 } = await acquireSession(OPTS) // in-use, not released
    await acquireSession(OPTS)
    expect(mockConnect).toHaveBeenCalledTimes(2)
    r1()
  })

  it('throws NetworkError when per-host limit (4) is reached', async () => {
    mockConnect.mockResolvedValue(makeMockSession() as never)

    // Acquire 4 sessions without releasing
    await acquireSession(OPTS)
    await acquireSession(OPTS)
    await acquireSession(OPTS)
    await acquireSession(OPTS)

    const { NetworkError } = await import('../../src/errors/index.js')
    await expect(acquireSession(OPTS)).rejects.toBeInstanceOf(NetworkError)
  })

  it('two different hosts have independent pool entries', async () => {
    mockConnect.mockResolvedValue(makeMockSession() as never)

    const { release: r1 } = await acquireSession(OPTS)
    const { release: r2 } = await acquireSession(OPTS2)
    expect(mockConnect).toHaveBeenCalledTimes(2)
    r1()
    r2()
  })

  it('released entry is reused for the same host but not for a different host', async () => {
    const s1 = makeMockSession()
    const s2 = makeMockSession()
    mockConnect
      .mockResolvedValueOnce(s1 as never)
      .mockResolvedValueOnce(s2 as never)

    const { release } = await acquireSession(OPTS)
    release()

    // Same host — should reuse s1
    const { session: reused } = await acquireSession(OPTS)
    expect(reused).toBe(s1)

    // Different host — should create s2
    const { session: fresh } = await acquireSession(OPTS2)
    expect(fresh).toBe(s2)
  })
})

describe('drainPool()', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    drainPool()
  })

  afterEach(() => {
    drainPool()
    vi.useRealTimers()
  })

  it('closes all pooled sessions', async () => {
    const s1 = makeMockSession()
    const s2 = makeMockSession()
    mockConnect
      .mockResolvedValueOnce(s1 as never)
      .mockResolvedValueOnce(s2 as never)

    const { release: r1 } = await acquireSession(OPTS)
    const { release: r2 } = await acquireSession(OPTS2)
    r1()
    r2()

    drainPool()

    expect(s1.close).toHaveBeenCalledTimes(1)
    expect(s2.close).toHaveBeenCalledTimes(1)
  })

  it('empties the pool so subsequent acquire opens a fresh connection', async () => {
    mockConnect.mockResolvedValue(makeMockSession() as never)

    const { release } = await acquireSession(OPTS)
    release()
    drainPool()

    await acquireSession(OPTS)
    expect(mockConnect).toHaveBeenCalledTimes(2) // first + after drain
  })
})

describe('idle TTL eviction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    drainPool()
    vi.useFakeTimers()
  })

  afterEach(() => {
    drainPool()
    vi.useRealTimers()
  })

  it('evicts idle sessions after 5 minutes', async () => {
    const session = makeMockSession()
    mockConnect.mockResolvedValue(session as never)

    const { release } = await acquireSession(OPTS)
    release() // mark idle

    // Advance past idle TTL (5 min) + cleanup interval (30s)
    await vi.advanceTimersByTimeAsync(5 * 60 * 1_000 + 31_000)

    expect(session.close).toHaveBeenCalledTimes(1)
  })

  it('does not evict a session that is still in use', async () => {
    const session = makeMockSession()
    mockConnect.mockResolvedValue(session as never)

    await acquireSession(OPTS) // in-use, NOT released

    await vi.advanceTimersByTimeAsync(5 * 60 * 1_000 + 31_000)

    expect(session.close).not.toHaveBeenCalled()
  })
})
