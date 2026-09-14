import { describe, it, expect, vi } from 'vitest'
import { waitForGateway } from '../../src/openclaw/ready.js'
import type { SshSession } from '../../src/transport/ssh.js'

const STARTED = JSON.stringify({ ok: true, status: 'started' })

/**
 * A host whose answers change over time: `states` is consumed one entry per poll, each giving
 * the container status and what the probe returns.
 */
function host(states: Array<{ container: string; probe?: string }>) {
  let i = 0
  // The probe belongs to the same poll as the inspect that preceded it, so the index only
  // advances after the probe has been answered.
  let current = states[0]!
  const exec = vi.fn(async (command: string) => {
    if (command.includes('docker inspect')) {
      current = states[Math.min(i, states.length - 1)]!
      i++
      return { stdout: `${current.container}\n`, stderr: '', code: 0 }
    }
    return { stdout: current.probe ?? '', stderr: '', code: 0 }
  })
  return { exec, close: vi.fn() } as unknown as SshSession & { exec: typeof exec }
}

const noSleep = vi.fn(async () => undefined)

describe('waitForGateway', () => {
  it('returns as soon as the gateway reports itself started', async () => {
    const session = host([{ container: 'running', probe: STARTED }])
    const result = await waitForGateway(session, { sleep: noSleep })
    expect(result.lastContainerStatus).toBe('running')
  })

  it('keeps waiting while the image is still being pulled', async () => {
    // `docker inspect` answers "not found" for the minutes a 3GB pull takes.
    const session = host([
      { container: 'not found' },
      { container: 'not found' },
      { container: 'created' },
      { container: 'running', probe: STARTED },
    ])
    await expect(waitForGateway(session, { sleep: noSleep, intervalMs: 1 })).resolves.toBeDefined()
  })

  it('does not accept a running container as a working gateway', async () => {
    // A running container says the process started, not that it serves. This is the whole
    // reason the probe exists.
    const session = host([
      { container: 'running', probe: '' },
      { container: 'running', probe: STARTED },
    ])
    await waitForGateway(session, { sleep: noSleep, intervalMs: 1 })
    const probes = session.exec.mock.calls.filter(([c]) => String(c).includes('curl'))
    expect(probes.length).toBe(2)
  })

  it('does not accept the Control UI as a health response', async () => {
    const session = host([
      { container: 'running', probe: '<!DOCTYPE html><html></html>' },
      { container: 'running', probe: STARTED },
    ])
    await expect(waitForGateway(session, { sleep: noSleep, intervalMs: 1 })).resolves.toBeDefined()
  })

  it('does not probe a container that is not running', async () => {
    const session = host([
      { container: 'not found' },
      { container: 'not found' },
      { container: 'running', probe: STARTED },
    ])
    await waitForGateway(session, { sleep: noSleep, intervalMs: 1 })
    const probes = session.exec.mock.calls.filter(([c]) => String(c).includes('curl'))
    // Exactly one: the poll where the container was running. Probing a container that does
    // not exist is a slower way to learn what `docker inspect` just said, and the count is
    // what pins that — an earlier version of this test asserted the first probe came after
    // the first inspect, which stays true however many pointless probes follow.
    expect(probes).toHaveLength(1)
  })

  it('gives up at the deadline, naming the container state and the last reason', async () => {
    const session = host([{ container: 'exited' }])
    let clock = 0
    await expect(
      waitForGateway(session, {
        sleep: noSleep,
        intervalMs: 1_000,
        timeoutMs: 5_000,
        now: () => (clock += 1_000),
      }),
    ).rejects.toThrow(/did not answer within 5s[\s\S]*Container: exited[\s\S]*clawops logs/)
  })

  it('distinguishes a container that never appeared from one that exited', async () => {
    let clock = 0
    const session = host([{ container: 'not found' }])
    await expect(
      waitForGateway(session, {
        sleep: noSleep,
        intervalMs: 1_000,
        timeoutMs: 5_000,
        now: () => (clock += 1_000),
      }),
    ).rejects.toThrow(/Container: not found/)
  })

  it('reports progress rather than going silent through a long pull', async () => {
    const onProgress = vi.fn()
    let clock = 0
    const session = host([
      { container: 'not found' },
      { container: 'not found' },
      { container: 'running', probe: STARTED },
    ])
    await waitForGateway(session, {
      sleep: noSleep,
      intervalMs: 1,
      onProgress,
      now: () => (clock += 31_000),
    })
    expect(onProgress).toHaveBeenCalled()
    expect(String(onProgress.mock.calls[0]?.[0])).toMatch(/3GB/)
  })

  it('reports at most once every 30 seconds, not once per poll', async () => {
    // Polling every 10s for four minutes would otherwise print two dozen near-identical
    // lines, which is its own kind of silence.
    const onProgress = vi.fn()
    let clock = 0
    const session = host([
      { container: 'not found' },
      { container: 'not found' },
      { container: 'not found' },
      { container: 'not found' },
      { container: 'running', probe: STARTED },
    ])
    await waitForGateway(session, {
      sleep: noSleep,
      intervalMs: 1,
      onProgress,
      // ~1s of wall clock per poll: four polls stay well inside one reporting window.
      now: () => (clock += 500),
    })
    expect(onProgress).toHaveBeenCalledTimes(1)
  })

  it('says nothing when the gateway is already up', async () => {
    const onProgress = vi.fn()
    await waitForGateway(host([{ container: 'running', probe: STARTED }]), {
      sleep: noSleep,
      onProgress,
    })
    expect(onProgress).not.toHaveBeenCalled()
  })

  it('stops when the signal is aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      waitForGateway(host([{ container: 'running', probe: STARTED }]), {
        sleep: noSleep,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted/)
  })

  it('probes the port the plan asked for', async () => {
    const session = host([{ container: 'running', probe: STARTED }])
    await waitForGateway(session, { sleep: noSleep, port: 9999 })
    const probe = session.exec.mock.calls.find(([c]) => String(c).includes('curl'))
    expect(String(probe?.[0])).toContain('127.0.0.1:9999')
  })
})
