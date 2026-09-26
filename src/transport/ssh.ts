// SSH transport — wraps ssh2. Never shells out to /usr/bin/ssh. Per I15.
// Per R13: every call accepts an AbortSignal.

import { readFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import path from 'node:path'
import { Client, type ConnectConfig } from 'ssh2'
import { NetworkError } from '../errors/index.js'
import {
  verifyAgainstKnownHosts,
  formatKnownHostsLine,
  keyTypeFromBlob,
} from './known-hosts.js'

/** Handle returned by SshSession.tunnel(); call close() to tear down. */
export interface TunnelHandle {
  localPort: number
  close(): void
}

export interface SshConnectOpts {
  host: string
  port: number
  user: string
  privateKeyPath: string
  knownHostsPath: string
  signal?: AbortSignal
  /**
   * Set by the readiness wait, and by nothing else.
   *
   * A refused connection means one thing to an operator running `clawops ssh` against a host
   * that has been up for a week, and another during the first half-minute of a VM's life, where
   * it is the expected answer. The diagnoses below are written for the first reader; told to the
   * second they would send someone to check a firewall that is fine. `waitForSsh` has its own
   * message for giving up, so during a wait clawops says only what ssh2 said.
   */
  awaitingBoot?: boolean
}

export interface SshExecResult {
  stdout: string
  stderr: string
  code: number
}

export interface SshSession {
  /** Run a command and collect its output. */
  exec(command: string, signal?: AbortSignal): Promise<SshExecResult>
  /** Run a command and return its stdout as a readable stream (for log tailing). */
  stream(command: string, signal?: AbortSignal): Promise<NodeJS.ReadableStream>
  /**
   * Run a command, feeding `input` to its stdin, and collect the output.
   *
   * `stream()` exposes only the read side, so there was no way to send a file to the host —
   * which `backup restore` needs, to put an archive back where it came from. Base64 through
   * `exec` would have worked for small archives and failed at ARG_MAX for real ones.
   */
  execWithInput(
    command: string,
    input: NodeJS.ReadableStream,
    signal?: AbortSignal,
  ): Promise<SshExecResult>
  /**
   * Open a local TCP server on localPort that forwards connections to
   * remoteHost:remotePort via SSH direct-tcpip. Returns a TunnelHandle;
   * call handle.close() to tear down the server and all open sockets.
   */
  tunnel(
    localPort: number,
    remoteHost: string,
    remotePort: number,
    signal?: AbortSignal,
  ): Promise<TunnelHandle>
  close(): void
}

class Ssh2Session implements SshSession {
  constructor(private readonly client: Client) {}

  exec(command: string, signal?: AbortSignal): Promise<SshExecResult> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new NetworkError('Operation aborted'))
        return
      }

      this.client.exec(command, (err, channel) => {
        if (err) {
          reject(new NetworkError(`SSH exec failed: ${err.message}`))
          return
        }

        let stdout = ''
        let stderr = ''

        const onAbort = () => {
          channel.destroy()
          reject(new NetworkError('Operation aborted'))
        }
        signal?.addEventListener('abort', onAbort, { once: true })

        channel.on('data', (data: Buffer) => {
          stdout += data.toString('utf-8')
        })
        channel.stderr.on('data', (data: Buffer) => {
          stderr += data.toString('utf-8')
        })
        channel.on('close', (code: number) => {
          signal?.removeEventListener('abort', onAbort)
          resolve({ stdout, stderr, code: code ?? 0 })
        })
        channel.on('error', (chanErr: Error) => {
          signal?.removeEventListener('abort', onAbort)
          reject(new NetworkError(`SSH channel error: ${chanErr.message}`))
        })
      })
    })
  }

  execWithInput(
    command: string,
    input: NodeJS.ReadableStream,
    signal?: AbortSignal,
  ): Promise<SshExecResult> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new NetworkError('Operation aborted'))
        return
      }

      this.client.exec(command, (err, channel) => {
        if (err) {
          reject(new NetworkError(`SSH exec failed: ${err.message}`))
          return
        }

        let stdout = ''
        let stderr = ''

        const onAbort = () => {
          channel.destroy()
          reject(new NetworkError('Operation aborted'))
        }
        signal?.addEventListener('abort', onAbort, { once: true })

        channel.on('data', (data: Buffer) => { stdout += data.toString('utf-8') })
        channel.stderr.on('data', (data: Buffer) => { stderr += data.toString('utf-8') })
        channel.on('close', (code: number) => {
          signal?.removeEventListener('abort', onAbort)
          resolve({ stdout, stderr, code: code ?? 0 })
        })
        channel.on('error', (chanErr: Error) => {
          signal?.removeEventListener('abort', onAbort)
          reject(new NetworkError(`SSH channel error: ${chanErr.message}`))
        })

        // The remote command sees EOF when the pipe closes, which is what tells it the
        // upload is complete.
        input.on('error', (readErr: Error) => {
          channel.destroy()
          signal?.removeEventListener('abort', onAbort)
          reject(new NetworkError(`Failed reading input: ${readErr.message}`))
        })
        input.pipe(channel)
      })
    })
  }

  stream(command: string, signal?: AbortSignal): Promise<NodeJS.ReadableStream> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new NetworkError('Operation aborted'))
        return
      }

      this.client.exec(command, (err, channel) => {
        if (err) {
          reject(new NetworkError(`SSH exec failed: ${err.message}`))
          return
        }

        if (signal) {
          signal.addEventListener('abort', () => channel.destroy(), { once: true })
        }

        resolve(channel)
      })
    })
  }

  tunnel(
    localPort: number,
    remoteHost: string,
    remotePort: number,
    signal?: AbortSignal,
  ): Promise<TunnelHandle> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new NetworkError('Operation aborted'))
        return
      }

      const sockets = new Set<Socket>()

      const server: Server = createServer((socket) => {
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))

        this.client.forwardOut('127.0.0.1', localPort, remoteHost, remotePort, (err, channel) => {
          if (err) {
            socket.destroy()
            return
          }
          socket.pipe(channel)
          channel.pipe(socket)
          channel.on('close', () => socket.destroy())
          socket.on('close', () => channel.destroy())
        })
      })

      const closeAll = (): void => {
        for (const s of sockets) s.destroy()
        server.close()
      }

      server.on('error', (err: NodeJS.ErrnoException) => {
        closeAll()
        const msg =
          err.code === 'EADDRINUSE'
            ? `Port ${localPort} is already in use`
            : `Tunnel server error: ${err.message}`
        reject(new NetworkError(msg))
      })

      server.listen(localPort, '127.0.0.1', () => {
        const handle: TunnelHandle = { localPort, close: closeAll }
        signal?.addEventListener('abort', closeAll, { once: true })
        resolve(handle)
      })
    })
  }

  close(): void {
    this.client.end()
  }
}

/**
 * Connect to a remote host via SSH.
 *
 * Host verification uses TOFU (Trust On First Use):
 * - If the host key is in known_hosts: it must match.
 * - If not: the key is accepted and appended to known_hosts.
 *
 * Entries are read in standard OpenSSH format, including hashed hostnames and
 * `[host]:port` forms; clawops's own legacy two-field hex lines are still accepted.
 */
/** What a connection failure means, split so `doctor` can render the advice on its own line. */
export interface ConnectDiagnosis {
  /** One line: what failed, ending with ssh2's own words in parentheses. */
  summary: string
  /** What to do about it. Absent when clawops has nothing to add to ssh2's message. */
  remedy?: string
}

export interface ConnectErrorOpts {
  host: string
  port: number
  knownHostsPath: string
  /** Named in the authentication diagnosis, when the caller knows it. */
  privateKeyPath?: string
  /** Named in the authentication diagnosis, when the caller knows it. */
  user?: string
  /** See `SshConnectOpts.awaitingBoot`. Suppresses everything but the host-key diagnosis. */
  awaitingBoot?: boolean
}

/**
 * Turn an ssh2 error into something an operator can act on.
 *
 * ssh2 reports the syscall and stops: `connect ECONNREFUSED 34.70.45.162:22`. That is the truth
 * and it is not a diagnosis — it does not distinguish the two failures an operator most needs
 * told apart. A refused connection means the packet arrived and nothing was listening. A timeout
 * means it arrived nowhere, and on a clawops stack that is usually the firewall: `--ssh-cidr
 * auto` admits the address the plan was made from, and addresses change.
 *
 * ssh2's own text is kept in every message. Operators paste it into issues, and — less
 * obviously — `waitForSsh` classifies retryable failures by reading it. Rewording a refusal
 * into something that no longer contains ECONNREFUSED would turn a booting instance into a
 * hard failure.
 */
export function diagnoseConnectError(message: string, opts: ConnectErrorOpts): ConnectDiagnosis {
  /*
   * The host-key diagnosis is not suppressed during a boot wait. It is the one failure here
   * that waiting cannot fix, and `waitForSsh` raises it immediately rather than retrying.
   *
   * ssh2 says "Host denied (verification failed)", which is accurate and says nothing about
   * what to do. On a cloud that almost always means a recycled address: the instance that
   * pinned this key is gone and a new one answers on its IP. `clawops destroy` now forgets the
   * key of an instance it tears down, so reaching this usually means a host clawops did not
   * destroy — or one destroyed by an older version.
   *
   * The advice stops short of "just delete it": an address changing hands unexpectedly is the
   * one case where this error is doing its job.
   */
  if (/host.*(denied|verification)/i.test(message)) {
    const entry = opts.port === 22 ? opts.host : `[${opts.host}]:${opts.port}`
    return {
      summary:
        `the host key for ${opts.host}:${opts.port} does not match the one recorded in ` +
        `${opts.knownHostsPath}. If your cloud reassigned this address — the usual cause — drop ` +
        'the stale entry and retry:',
      remedy:
        `  ssh-keygen -R ${entry} -f ${opts.knownHostsPath}\n` +
        'If you did not expect this address to change hands, do not connect.',
    }
  }

  if (opts.awaitingBoot) return { summary: `SSH connection failed: ${message}` }

  if (message.includes('ECONNREFUSED')) {
    return {
      summary:
        `${opts.host}:${opts.port} refused the connection — the host is reachable and nothing ` +
        `is listening on that port (${message}).`,
      remedy:
        'The instance is up and sshd is not. Check the instance state with `clawops status ' +
        '--stack <name>`, and that the port matches the one the stack was deployed with.',
    }
  }

  if (/ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|Timed out while waiting for handshake/.test(message)) {
    return {
      // ssh2's readyTimeout (30s) usually fires before the kernel gives up on the TCP connect,
      // so a dropping firewall is reported as a handshake timeout rather than ETIMEDOUT. Both
      // mean the same thing to the operator: nothing came back.
      summary:
        `${opts.host}:${opts.port} never answered — nothing came back at all, which is what a ` +
        `firewall dropping the packets looks like (${message}).`,
      remedy:
        'On a clawops stack the usual cause is that the security group no longer admits this ' +
        'machine: `--ssh-cidr auto` pins the address you planned from, and home, office and VPN ' +
        'addresses change. Re-plan from where you are now and apply:\n' +
        '  clawops plan --stack <name> --ssh-cidr auto --out <plan>.json\n' +
        '  clawops apply <plan>.json\n' +
        'If the address has not changed, the instance may be stopped or still booting.',
    }
  }

  if (message.includes('ENOTFOUND')) {
    return {
      summary: `${opts.host} does not resolve (${message}).`,
      remedy:
        'Check the address recorded for this stack with `clawops stacks list`. An instance ' +
        'replaced outside clawops keeps the old address in `~/.clawops/config.json`.',
    }
  }

  if (message.includes('All configured authentication methods failed')) {
    const key = opts.privateKeyPath
    const asUser = opts.user ? ` as ${opts.user}` : ''
    return {
      summary: `${opts.host}:${opts.port} rejected every authentication method clawops offered${asUser} (${message}).`,
      remedy: key
        ? `clawops offered the key at ${key}. Its public half may not be installed on the host — ` +
          'an instance rebuilt outside clawops, or a key regenerated since this stack was ' +
          `created. Compare what clawops offers, \`ssh-keygen -y -f ${key}\`, against the ` +
          'authorized_keys on the host.'
        : 'The key clawops offered may not be installed on the host — an instance rebuilt ' +
          'outside clawops, or a key regenerated since this stack was created.',
    }
  }

  if (/no matching|Handshake failed/i.test(message)) {
    return {
      summary: `no algorithm the SSH handshake needs is accepted by both ends (${message}).`,
      remedy:
        'The host is running an OpenSSH older than the algorithms ssh2 offers. clawops does not ' +
        'deploy hosts that old, so this is usually a pre-existing machine registered with the ' +
        'local provider; upgrading its OpenSSH is the fix.',
    }
  }

  return { summary: `SSH connection failed: ${message}` }
}

/** The diagnosis as one message, for an error that is about to be thrown. */
export function describeConnectError(message: string, opts: ConnectErrorOpts): string {
  const { summary, remedy } = diagnoseConnectError(message, opts)
  return remedy ? `${summary}\n${remedy}` : summary
}

export async function connect(opts: SshConnectOpts): Promise<SshSession> {
  let privateKey: Buffer
  try {
    privateKey = readFileSync(opts.privateKeyPath)
  } catch (err) {
    throw new NetworkError(
      `Cannot read SSH private key at ${opts.privateKeyPath}: ${(err as Error).message}`,
    )
  }

  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new NetworkError('Connection aborted'))
      return
    }

    const client = new Client()

    const onAbort = () => {
      client.destroy()
      reject(new NetworkError('Connection aborted'))
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    client.on('ready', () => {
      opts.signal?.removeEventListener('abort', onAbort)
      resolve(new Ssh2Session(client))
    })

    client.on('error', (err) => {
      opts.signal?.removeEventListener('abort', onAbort)
      reject(new NetworkError(describeConnectError(err.message, opts)))
    })

    const config: ConnectConfig = {
      host: opts.host,
      port: opts.port,
      username: opts.user,
      privateKey,
      readyTimeout: 30_000,
      hostVerifier: (keyHash: Buffer) =>
        verifyHostKey(opts.host, opts.port, keyHash, opts.knownHostsPath),
    }

    client.connect(config)
  })
}

/**
 * TOFU host verification: accept-and-record unknown keys, reject changed keys.
 * Returns true to accept, false to reject.
 */
function verifyHostKey(
  host: string,
  port: number,
  keyHash: Buffer,
  knownHostsPath: string,
): boolean {
  let content = ''
  try {
    content = readFileSync(knownHostsPath, 'utf-8')
  } catch {
    // No file yet — trust on first use below.
  }

  const verdict = verifyAgainstKnownHosts(content, host, port, keyHash)
  if (verdict === 'match') return true
  if (verdict === 'mismatch') return false

  // Unknown host — trust on first use, and record it in standard OpenSSH format so the
  // file stays valid for `ssh` itself and for a knownHostsPath pointed at ~/.ssh.
  const keyType = keyTypeFromBlob(keyHash)
  if (!keyType) return false
  try {
    mkdirSync(path.dirname(knownHostsPath), { recursive: true })
    appendFileSync(knownHostsPath, formatKnownHostsLine(host, port, keyType, keyHash), 'utf-8')
  } catch {
    // Non-fatal: accept even if we cannot persist.
  }

  return true
}
