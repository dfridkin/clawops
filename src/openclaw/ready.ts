// Waiting for the deployment, not just the machine.
//
// `clawops apply` waited for SSH and then reported success, while the startup script was still
// pulling OpenClaw:
//
//   Remote health
//   ✗  Container    not found
//   ✗  Gateway      no response from the gateway
//
// The image is around 3GB, so a first deploy spends minutes there. Every command clawops offers
// next — `logs`, `gateway`, `config`, `agents`, `doctor --stack` — assumes a gateway that
// answers, so reporting "Done" before one exists hands the operator a deployment that fails at
// whatever they try first.
//
// `/startupz` is the gate: a running container says the process started, not that it serves.

import { probeCommand, interpretProbe } from './health.js'
import { GATEWAY_PORT } from './run-flags.js'
import { execPrivileged } from '../transport/privileged.js'
import type { SshSession } from '../transport/ssh.js'

export interface WaitForGatewayOpts {
  /** Default 10 minutes: long enough for a 3GB pull on a slow link, short enough to end. */
  timeoutMs?: number
  /** Default 10s. The probe is a curl on the host; polling faster buys nothing. */
  intervalMs?: number
  /** Default GATEWAY_PORT. */
  port?: number
  signal?: AbortSignal
  /** Called at most every 30s, so a long pull does not look like a hang. */
  onProgress?: (line: string) => void
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  now?: () => number
}

export interface GatewayReadyResult {
  /** How long the wait took, for the caller to report. */
  waitedMs: number
  /** What the container was doing at the last check — for the timeout message. */
  lastContainerStatus: string
}

/**
 * Resolve once the gateway answers `/startupz`, or throw when the deadline passes.
 *
 * The container's state is read alongside the probe so a timeout can say which of the two
 * things went wrong: an image still downloading and a container that exited immediately are
 * both "no response from the gateway", and they need different answers from the operator.
 */
export async function waitForGateway(
  session: SshSession,
  opts: WaitForGatewayOpts = {},
): Promise<GatewayReadyResult> {
  const timeoutMs = opts.timeoutMs ?? 600_000
  const intervalMs = opts.intervalMs ?? 10_000
  const port = opts.port ?? GATEWAY_PORT
  const sleep = opts.sleep ?? defaultSleep
  const now = opts.now ?? Date.now
  const started = now()
  const deadline = started + timeoutMs

  let lastContainerStatus = 'unknown'
  let lastReason = 'not probed yet'
  let announcedAt = 0

  for (;;) {
    if (opts.signal?.aborted) throw new Error('Waiting for the gateway was aborted')

    const container = await execPrivileged(
      session,
      `docker inspect openclaw --format '{{.State.Status}}' 2>/dev/null || echo 'not found'`,
      opts.signal,
    )
    lastContainerStatus = container.stdout.trim() || 'unknown'

    if (lastContainerStatus === 'running') {
      const probe = await session.exec(probeCommand('started', port), opts.signal)
      const verdict = interpretProbe('started', probe.stdout)
      if (verdict.ok) return { waitedMs: now() - started, lastContainerStatus }
      lastReason = verdict.reason ?? 'the gateway did not report itself started'
    } else {
      lastReason = `the container is ${lastContainerStatus}`
    }

    const elapsed = now() - started
    if (elapsed - announcedAt >= 30_000 || announcedAt === 0) {
      announcedAt = elapsed
      opts.onProgress?.(
        `Waiting for OpenClaw to start — ${lastReason}. ` +
          `A first deploy pulls a ~3GB image (${Math.round(elapsed / 1000)}s so far).`,
      )
    }

    if (now() + intervalMs >= deadline) {
      throw new Error(
        `The OpenClaw gateway did not answer within ${Math.round(timeoutMs / 1000)}s. ` +
          `Container: ${lastContainerStatus}. Last check: ${lastReason}. ` +
          'The instance is up — `clawops logs --stack <name>` shows what it is doing.',
      )
    }
    await sleep(intervalMs, opts.signal)
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('Waiting for the gateway was aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
