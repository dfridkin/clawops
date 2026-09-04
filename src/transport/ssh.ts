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
      reject(new NetworkError(`SSH connection failed: ${err.message}`))
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
