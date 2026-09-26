// Waiting for a freshly created host to accept SSH.
//
// `clawops apply` printed its success line, the gateway URL and the public IP the moment
// Pulumi returned — while the VM was still booting. Every command run after it failed:
//
//   ✗  Connection   SSH connection failed: connect ECONNREFUSED 34.70.45.162:22
//
// and so did apply's own config-overlay step, which connects immediately after `stack.up`.
// Nothing in clawops waited for anything. A deploy tool that reports success for a machine
// nothing can reach has reported the wrong thing.
//
// ECONNREFUSED is the expected answer for the first half-minute of a VM's life: the packet
// arrived and nothing was listening yet. An authentication failure is not — it will still be
// there in five minutes, so it is raised at once rather than retried until the deadline.

import { NetworkError } from '../errors/index.js'
import { connect as sshConnect, type SshConnectOpts, type SshSession } from './ssh.js'

/** Errors that mean "not yet", as opposed to "not ever". */
const TRANSIENT = [
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ECONNRESET',
  'EPIPE',
  'ENOTFOUND',
  'Timed out while waiting for handshake',
  'Connection closed by server',
  'Connection lost before handshake',
  'All configured authentication methods failed',
]

/**
 * `All configured authentication methods failed` is in that list deliberately. On GCP the
 * instance's key is installed by the guest agent a moment after sshd starts, so the first
 * connections are refused for authentication reasons and then start working. A genuinely wrong
 * key looks identical — which is why the wait has a deadline and the error says what to check.
 */
export function isTransient(message: string): boolean {
  return TRANSIENT.some((t) => message.includes(t))
}

export interface WaitForSshOpts {
  /** Give up after this long. Default 5 minutes: a cloud VM that is not up by then is stuck. */
  timeoutMs?: number
  /** Between attempts. Default 5s. */
  intervalMs?: number
  signal?: AbortSignal
  /** Called before the first retry and on each one, so a slow boot does not look like a hang. */
  onProgress?: (line: string) => void
  /** Injectable for tests; defaults to the real SSH connect. */
  connect?: (opts: SshConnectOpts) => Promise<SshSession>
  /** Injectable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/**
 * The session that proved the host is up, for the caller to use and close.
 *
 * It used to close that session and return nothing, which left the caller to open a second
 * one — and a second connection to a host that started accepting them moments ago is not
 * guaranteed to succeed. On AWS it did not:
 *
 *   SSH is up after 2 attempts.
 *   ✖ Deployment failed
 *     SSH connection failed: Timed out while waiting for handshake
 *
 * The wait retried; the connection right after it had no retries at all. Handing back the
 * proven session removes that gap rather than adding a second retry loop behind the first, and
 * costs one connection instead of two.
 */
export async function waitForSsh(
  conn: SshConnectOpts,
  opts: WaitForSshOpts = {},
): Promise<SshSession> {
  const timeoutMs = opts.timeoutMs ?? 300_000
  const intervalMs = opts.intervalMs ?? 5_000
  const connect = opts.connect ?? sshConnect
  const sleep = opts.sleep ?? defaultSleep
  const deadline = Date.now() + timeoutMs

  let attempts = 0
  let lastError = 'no attempt completed'

  for (;;) {
    if (opts.signal?.aborted) throw new NetworkError('Waiting for SSH was aborted')
    attempts++
    try {
      // awaitingBoot: a refused connection is the expected answer here, so the transport's
      // day-2 diagnoses ("the instance is up and sshd is not") would be advice about a problem
      // that does not exist. The deadline message below is this path's own diagnosis.
      const session = await connect({ ...conn, awaitingBoot: true, signal: opts.signal })
      if (attempts > 1) opts.onProgress?.(`SSH is up after ${attempts} attempts.`)
      return session
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      if (!isTransient(lastError)) {
        // A wrong key or a changed host key is not going to fix itself; say so now rather than
        // after five minutes of retrying.
        throw new NetworkError(
          `SSH to ${conn.host}:${conn.port} failed for a reason waiting will not fix: ${lastError}`,
        )
      }
      if (attempts === 1) {
        opts.onProgress?.(
          `Waiting for ${conn.host}:${conn.port} to accept SSH — a new instance takes a minute.`,
        )
      }
    }

    if (Date.now() + intervalMs >= deadline) {
      throw new NetworkError(
        `${conn.host}:${conn.port} did not accept SSH within ${Math.round(timeoutMs / 1000)}s ` +
          `(${attempts} attempts, last error: ${lastError}). The instance may still be booting, ` +
          'or the firewall may not admit this machine — check `clawops doctor --stack <name>`.',
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
      reject(new NetworkError('Waiting for SSH was aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
