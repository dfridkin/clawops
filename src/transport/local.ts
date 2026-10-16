// A session on this machine — the host agent's transport (ADR 0014).
//
// Every read tool reaches its gateway through an SshSession: it runs `docker logs`, reads
// openclaw.json, asks the gateway for its status. A host agent runs on that host, so the same
// commands run here, through bash, with the same interface. The tools do not know the
// difference, which is the point: a host agent's `logs_tail` is the operator's `logs_tail`,
// not a second implementation that could drift from it.
//
// This is not a way around the SSH rules. It runs the commands clawops' own tool code builds,
// on the machine the process is on, and only in host-agent mode (see ./pool.ts).

import { spawn } from 'node:child_process'
import { NetworkError } from '../errors/index.js'
import type { SshExecResult, SshSession, TunnelHandle } from './ssh.js'

const SHELL = '/bin/bash'

function run(
  command: string,
  input: NodeJS.ReadableStream | undefined,
  signal: AbortSignal | undefined,
): Promise<SshExecResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new NetworkError('Command aborted'))
      return
    }
    const child = spawn(SHELL, ['-c', command], {
      stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      signal,
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf-8').on('data', (d: string) => { stdout += d })
    child.stderr?.setEncoding('utf-8').on('data', (d: string) => { stderr += d })
    child.on('error', (err) => {
      reject(new NetworkError(signal?.aborted ? 'Command aborted' : `Could not run a local command: ${err.message}`))
    })
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 1 }))
    if (input && child.stdin) input.pipe(child.stdin)
  })
}

class LocalSession implements SshSession {
  exec(command: string, signal?: AbortSignal): Promise<SshExecResult> {
    return run(command, undefined, signal)
  }

  async stream(command: string, signal?: AbortSignal): Promise<NodeJS.ReadableStream> {
    const child = spawn(SHELL, ['-c', command], { stdio: ['ignore', 'pipe', 'ignore'], signal })
    if (!child.stdout) throw new NetworkError("Could not read a local command's output.")
    return child.stdout
  }

  execWithInput(command: string, input: NodeJS.ReadableStream, signal?: AbortSignal): Promise<SshExecResult> {
    return run(command, input, signal)
  }

  tunnel(): Promise<TunnelHandle> {
    // Nothing a host agent serves forwards a port; the gateway is already on this machine.
    return Promise.reject(new NetworkError('A host agent does not open tunnels.'))
  }

  close(): void {
    // Each command is its own process; there is no connection to close.
  }
}

export function localSession(): SshSession {
  return new LocalSession()
}
