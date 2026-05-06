// SSH transport — wraps ssh2. Never shells out to /usr/bin/ssh. Per I15.
// Per R13: every call accepts an AbortSignal.

import { readFileSync, appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { Client, type ConnectConfig } from 'ssh2'
import { NetworkError } from '../errors/index.js'

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
 * TODO M2: implement full RFC 4253 known_hosts verification.
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
  const keyHex = keyHash.toString('hex')
  const hostEntry = port === 22 ? host : `[${host}]:${port}`

  let existing: string | null = null
  try {
    const content = readFileSync(knownHostsPath, 'utf-8')
    for (const line of content.split('\n')) {
      const parts = line.trim().split(/\s+/)
      if (parts[0] === hostEntry && parts.length >= 2) {
        existing = parts[1] ?? null
        break
      }
    }
  } catch {
    // File doesn't exist yet — TOFU first use
  }

  if (existing !== null) {
    return existing === keyHex
  }

  // First time seeing this host — record key (TOFU)
  try {
    mkdirSync(path.dirname(knownHostsPath), { recursive: true })
    appendFileSync(knownHostsPath, `${hostEntry} ${keyHex}\n`, 'utf-8')
  } catch {
    // Non-fatal: accept even if we can't persist
  }

  return true
}
