// Local provider bootstrap — runs the idempotent bootstrap.sh on the remote host via SSH.
// Transfers the rendered script over SSH exec (no SCP dependency).

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { acquireSession } from '../../transport/pool.js'
import { writeLocalState, type LocalState } from './state.js'
import { ProviderError } from '../../errors/index.js'

const GATEWAY_PORT = 18789
const HEALTH_POLL_INTERVAL_MS = 3_000
const HEALTH_TIMEOUT_MS = 120_000

export interface BootstrapOpts {
  host: string
  port: number
  user: string
  privateKeyPath: string
  knownHostsPath: string
  openclawVersion: string
  stackName: string
  noWait?: boolean
  /** Sudo password for hosts that require one. When set, sudo -S is used so no TTY is needed. */
  sudoPassword?: string
  /** Called with each stdout line as the bootstrap script runs. */
  onOutput?: (line: string) => void
  signal?: AbortSignal
}

function loadTemplate(): string {
  // Works in both ts-node/tsx (src/) and compiled (dist/) forms.
  const dir = path.dirname(fileURLToPath(import.meta.url))
  return readFileSync(path.join(dir, 'bootstrap.sh.tmpl'), 'utf-8')
}

function renderScript(openclawVersion: string): string {
  return loadTemplate().replace(/\{\{OPENCLAW_VERSION\}\}/g, openclawVersion)
}

/**
 * Run the bootstrap script on the remote host and persist LocalState.
 * The script is base64-encoded and piped to bash to avoid any quoting issues.
 */
export async function localBootstrap(opts: BootstrapOpts): Promise<LocalState> {
  const script = renderScript(opts.openclawVersion)
  const b64 = Buffer.from(script, 'utf-8').toString('base64')
  // When a sudo password is provided, use `sudo -S` (reads password from stdin).
  // The password is fed via printf so stdin remains free for the inline -c command.
  const command = opts.sudoPassword
    ? `printf '%s\n' ${shellQuote(opts.sudoPassword)} | sudo -S bash -c "echo '${b64}' | base64 -d | bash"`
    : `echo '${b64}' | base64 -d | sudo bash`

  const { session, release } = await acquireSession({
    host: opts.host,
    port: opts.port,
    user: opts.user,
    privateKeyPath: opts.privateKeyPath,
    knownHostsPath: opts.knownHostsPath,
    signal: opts.signal,
  })

  try {
    if (opts.onOutput) {
      await execStreaming(session, command, opts.onOutput, opts.signal)
    } else {
      const result = await session.exec(command, opts.signal)
      if (result.code !== 0) {
        throw new ProviderError(
          `Bootstrap script failed (exit ${result.code}):\n${result.stderr || result.stdout}`,
        )
      }
    }
  } finally {
    release()
  }

  const state: LocalState = {
    instanceId: `local:${opts.host}`,
    publicIp: opts.host,
    gatewayUrl: `http://${opts.host}:${GATEWAY_PORT}`,
    sshHost: opts.host,
    sshPort: opts.port,
    sshUser: opts.user,
    region: 'local',
    provisionedAt: new Date().toISOString(),
    privateKeyPath: opts.privateKeyPath,
    knownHostsPath: opts.knownHostsPath,
  }

  writeLocalState(opts.stackName, state)

  if (!opts.noWait) {
    await waitForGateway(opts.host, GATEWAY_PORT, opts.signal)
  }

  return state
}

async function waitForGateway(
  host: string,
  port: number,
  signal?: AbortSignal,
): Promise<void> {
  const url = `http://${host}:${port}/health`
  const deadline = Date.now() + HEALTH_TIMEOUT_MS

  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw new ProviderError('Bootstrap aborted while waiting for gateway')
    }
    try {
      const res = await fetch(url, { signal })
      if (res.ok) return
    } catch {
      // Not ready yet — keep polling
    }
    await sleep(HEALTH_POLL_INTERVAL_MS)
  }

  throw new ProviderError(
    `Gateway at ${url} did not become healthy within ${HEALTH_TIMEOUT_MS / 1000}s`,
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Wrap a string in single quotes, escaping any single quotes inside it.
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

// The ssh2 ClientChannel is a Duplex stream with .stderr and a 'close' event
// that carries the exit code. session.stream() returns it typed as ReadableStream
// so we cast to access those properties.
type SshChannel = NodeJS.ReadableStream & {
  stderr: NodeJS.ReadableStream
  on(event: 'close', listener: (code: number) => void): SshChannel
  on(event: 'error', listener: (err: Error) => void): SshChannel
  on(event: 'data', listener: (chunk: Buffer) => void): SshChannel
}

async function execStreaming(
  session: { stream(cmd: string, signal?: AbortSignal): Promise<NodeJS.ReadableStream> },
  command: string,
  onOutput: (line: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const ch = (await session.stream(command, signal)) as unknown as SshChannel

  let leftover = ''
  let stderr = ''

  ch.on('data', (chunk: Buffer) => {
    const text = leftover + chunk.toString('utf-8')
    const lines = text.split('\n')
    leftover = lines.pop() ?? ''
    for (const line of lines) {
      if (line.trim()) onOutput(line)
    }
  })

  ch.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf-8')
  })

  const exitCode = await new Promise<number>((resolve, reject) => {
    ch.on('close', (code) => {
      if (leftover.trim()) onOutput(leftover)
      resolve(code ?? 0)
    })
    ch.on('error', reject)
  })

  if (exitCode !== 0) {
    throw new ProviderError(`Bootstrap script failed (exit ${exitCode}):\n${stderr}`)
  }
}
