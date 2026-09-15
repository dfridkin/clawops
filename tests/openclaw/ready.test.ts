import { describe, it, expect, vi } from 'vitest'
import { waitForGateway, bootstrapTail } from '../../src/openclaw/ready.js'
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

describe('bootstrapTail', () => {
  function sessionReturning(stdout: string, throws = false) {
    return {
      exec: vi.fn(async () => {
        if (throws) throw new Error('connection closed')
        return { stdout, stderr: '', code: 0 }
      }),
    } as unknown as SshSession
  }

  it('returns what the bootstrap log says', async () => {
    await expect(bootstrapTail(sessionReturning('E: Unable to acquire the dpkg lock\n')))
      .resolves.toContain('dpkg lock')
  })

  it('is undefined when the log is empty', async () => {
    await expect(bootstrapTail(sessionReturning('   \n'))).resolves.toBeUndefined()
  })

  it('never throws — it runs when something has already gone wrong', async () => {
    // A diagnostic that throws replaces the real error with its own.
    await expect(bootstrapTail(sessionReturning('', true))).resolves.toBeUndefined()
  })

  it('falls back to the startup-script unit when cloud-init has no log', async () => {
    const session = sessionReturning('x')
    await bootstrapTail(session)
    const command = String((session.exec as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])
    expect(command).toContain('/var/log/cloud-init-output.log')
    expect(command).toContain('google-startup-scripts')
  })
})

describe('what a timeout tells the operator', () => {
  it('carries the bootstrap log, because the instance may not outlive the error', async () => {
    // An automated run destroys the host on its way out, and the evidence goes with it. This
    // failure is the only chance to capture what the bootstrap was doing.
    let clock = 0
    const session = {
      exec: vi.fn(async (command: string) => {
        if (String(command).includes('cloud-init-output')) {
          return { stdout: 'E: Could not get lock /var/lib/dpkg/lock-frontend\n', stderr: '', code: 0 }
        }
        return { stdout: 'not found\n', stderr: '', code: 0 }
      }),
    } as unknown as SshSession

    await expect(
      waitForGateway(session, {
        sleep: noSleep,
        intervalMs: 1_000,
        timeoutMs: 5_000,
        now: () => (clock += 1_000),
      }),
    ).rejects.toThrow(/bootstrap log[\s\S]*dpkg/)
  })

  it('still says where to look when the log cannot be read', async () => {
    let clock = 0
    const session = {
      exec: vi.fn(async (command: string) => {
        if (String(command).includes('cloud-init-output')) throw new Error('closed')
        return { stdout: 'not found\n', stderr: '', code: 0 }
      }),
    } as unknown as SshSession

    await expect(
      waitForGateway(session, {
        sleep: noSleep,
        intervalMs: 1_000,
        timeoutMs: 5_000,
        now: () => (clock += 1_000),
      }),
    ).rejects.toThrow(/clawops logs --stack/)
  })
})

describe('a host that will not answer about the container', () => {
  it('stops rather than waiting ten minutes on a refusal', async () => {
    // The fourth Azure run waited the full timeout for a container that was up and healthy the
    // whole time, because a permission error had been laundered into "not found".
    const session = {
      exec: vi.fn(async (command: string) => {
        if (String(command).includes('inspect')) {
          return {
            stdout: '',
            stderr: 'permission denied while trying to connect to the Docker daemon socket',
            code: 1,
          }
        }
        return { stdout: '', stderr: 'sudo: a password is required', code: 1 }
      }),
    } as unknown as SshSession

    await expect(waitForGateway(session, { sleep: noSleep, intervalMs: 1 })).rejects.toThrow(
      /Could not ask the host about the openclaw container[\s\S]*unable to look/,
    )
  })
})

describe('a host that has not installed Docker yet', () => {
  /** Docker missing for the first few polls, then a healthy container. */
  function bootingHost(missingPolls: number) {
    let polls = 0
    return {
      exec: vi.fn(async (command: string) => {
        const c = String(command)
        if (c.includes('inspect')) {
          polls++
          if (polls <= missingPolls) {
            return { stdout: '', stderr: 'bash: line 1: docker: command not found', code: 127 }
          }
          return { stdout: 'running\n', stderr: '', code: 0 }
        }
        if (c.includes('curl')) return { stdout: STARTED, stderr: '', code: 0 }
        return { stdout: '', stderr: 'sudo: a password is required', code: 1 }
      }),
    } as unknown as SshSession
  }

  it('keeps waiting rather than failing the deploy', async () => {
    // The first version of this fix treated any probe error as fatal, which turned a normal
    // boot into a failed deploy on the very next run.
    await expect(
      waitForGateway(bootingHost(3), { sleep: noSleep, intervalMs: 1 }),
    ).resolves.toMatchObject({ lastContainerStatus: 'running' })
  })

  it('says what it is waiting for', async () => {
    const onProgress = vi.fn()
    let clock = 0
    await waitForGateway(bootingHost(2), {
      sleep: noSleep,
      intervalMs: 1,
      onProgress,
      now: () => (clock += 31_000),
    })
    expect(String(onProgress.mock.calls[0]?.[0])).toMatch(/docker could not be asked yet/)
  })

  it('still stops at once on a refusal, which waiting cannot fix', async () => {
    const refusing = {
      exec: vi.fn(async (command: string) =>
        String(command).startsWith('sudo')
          ? { stdout: '', stderr: 'sudo: a password is required', code: 1 }
          : { stdout: '', stderr: 'permission denied … docker.sock', code: 1 },
      ),
    } as unknown as SshSession
    await expect(waitForGateway(refusing, { sleep: noSleep, intervalMs: 1 })).rejects.toThrow(
      /unable to look/,
    )
  })
})
