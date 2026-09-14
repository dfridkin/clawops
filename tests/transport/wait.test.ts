import { describe, it, expect, vi } from 'vitest'
import { waitForSsh, isTransient } from '../../src/transport/wait.js'

const CONN = {
  host: '203.0.113.4',
  port: 22,
  user: 'clawops',
  privateKeyPath: '/tmp/key',
  knownHostsPath: '/tmp/known_hosts',
}

/** A connect that fails `failures` times, then succeeds. */
function flaky(failures: number, message = 'SSH connection failed: connect ECONNREFUSED') {
  let calls = 0
  const close = vi.fn()
  const connect = vi.fn(async () => {
    calls++
    if (calls <= failures) throw new Error(message)
    return { close }
  })
  return { connect, close, calls: () => calls }
}

const noSleep = vi.fn(async () => undefined)

describe('isTransient', () => {
  it.each([
    'connect ECONNREFUSED 203.0.113.4:22',
    'connect ETIMEDOUT',
    'Timed out while waiting for handshake',
    'All configured authentication methods failed',
  ])('treats %s as "not yet"', (message) => {
    expect(isTransient(message)).toBe(true)
  })

  it.each([
    'Host key verification failed',
    'Cannot read SSH private key at /tmp/key: ENOENT',
    'Unable to parse private key',
  ])('treats %s as "not ever"', (message) => {
    expect(isTransient(message)).toBe(false)
  })
})

describe('waitForSsh', () => {
  it('returns as soon as the host accepts a session', async () => {
    const { connect, calls } = flaky(0)
    await waitForSsh(CONN, { connect, sleep: noSleep })
    expect(calls()).toBe(1)
  })

  it('closes the session it opened to prove the host is up', async () => {
    const { connect, close } = flaky(0)
    await waitForSsh(CONN, { connect, sleep: noSleep })
    // One leaked connection per apply otherwise.
    expect(close).toHaveBeenCalledOnce()
  })

  it('retries a refused connection until it is accepted', async () => {
    // ECONNREFUSED is the expected answer for the first half-minute of a VM's life.
    const { connect, calls } = flaky(5)
    await waitForSsh(CONN, { connect, sleep: noSleep, intervalMs: 1, timeoutMs: 60_000 })
    expect(calls()).toBe(6)
  })

  it('waits between attempts rather than spinning', async () => {
    const sleep = vi.fn(async () => undefined)
    const { connect } = flaky(2)
    await waitForSsh(CONN, { connect, sleep, intervalMs: 5_000, timeoutMs: 60_000 })
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(5_000, undefined)
  })

  it('gives up at the deadline, naming the host and the last error', async () => {
    const { connect } = flaky(Infinity)
    await expect(
      waitForSsh(CONN, { connect, sleep: noSleep, intervalMs: 1_000, timeoutMs: 3_000 }),
    ).rejects.toThrow(/203\.0\.113\.4:22 did not accept SSH within 3s[\s\S]*ECONNREFUSED/)
  })

  it('does not retry a failure that waiting cannot fix', async () => {
    // A wrong key is still wrong in five minutes. Retrying it just delays the error.
    const { connect, calls } = flaky(Infinity, 'Host key verification failed')
    await expect(waitForSsh(CONN, { connect, sleep: noSleep })).rejects.toThrow(
      /waiting will not fix: Host key verification failed/,
    )
    expect(calls()).toBe(1)
  })

  it('announces the wait once, before the first retry', async () => {
    const onProgress = vi.fn()
    const { connect } = flaky(3)
    await waitForSsh(CONN, { connect, sleep: noSleep, intervalMs: 1, timeoutMs: 60_000, onProgress })
    const lines = onProgress.mock.calls.map((c) => String(c[0]))
    expect(lines.filter((l) => l.includes('Waiting for'))).toHaveLength(1)
    expect(lines.at(-1)).toMatch(/SSH is up after 4 attempts/)
  })

  it('says nothing at all when the host is up immediately', async () => {
    const onProgress = vi.fn()
    const { connect } = flaky(0)
    await waitForSsh(CONN, { connect, sleep: noSleep, onProgress })
    expect(onProgress).not.toHaveBeenCalled()
  })

  it('stops when the signal is aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const { connect, calls } = flaky(0)
    await expect(waitForSsh(CONN, { connect, sleep: noSleep, signal: controller.signal }))
      .rejects.toThrow(/aborted/)
    expect(calls()).toBe(0)
  })

  it('passes the signal to each connection attempt', async () => {
    const controller = new AbortController()
    const { connect } = flaky(0)
    await waitForSsh(CONN, { connect, sleep: noSleep, signal: controller.signal })
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }))
  })
})
