// FakeSshClient — in-process test double for SshSession.
// Use in unit tests that exercise SSH-dependent code without a real connection.

import type { SshSession, SshExecResult, TunnelHandle } from '../../src/transport/ssh.js'
import { Readable } from 'node:stream'

export type ExecHandler = (command: string) => SshExecResult | Promise<SshExecResult>
export type StreamHandler = (command: string) => NodeJS.ReadableStream
export type TunnelHandler = (
  localPort: number,
  remoteHost: string,
  remotePort: number,
) => TunnelHandle

export class FakeSshSession implements SshSession {
  private execHandlers: ExecHandler[] = []
  private streamHandlers: StreamHandler[] = []
  private tunnelHandlers: TunnelHandler[] = []
  private execLog: string[] = []
  private streamLog: string[] = []
  closed = false

  /** Every command passed to exec(), in order. */
  execCalls(): string[] {
    return [...this.execLog]
  }

  /** Every command passed to stream(), in order. */
  streamCalls(): string[] {
    return [...this.streamLog]
  }

  /** Queue a handler that will respond to the next exec() call. */
  onExec(handler: ExecHandler): this {
    this.execHandlers.push(handler)
    return this
  }

  /** Queue a handler that will respond to the next stream() call. */
  onStream(handler: StreamHandler): this {
    this.streamHandlers.push(handler)
    return this
  }

  /** Queue a handler that will respond to the next tunnel() call. */
  onTunnel(handler: TunnelHandler): this {
    this.tunnelHandlers.push(handler)
    return this
  }

  async exec(command: string, signal?: AbortSignal): Promise<SshExecResult> {
    this.execLog.push(command)
    if (signal?.aborted) throw new Error('Operation aborted')
    const handler = this.execHandlers.shift()
    if (!handler) {
      return { stdout: '', stderr: `no handler for exec: ${command}`, code: 0 }
    }
    return handler(command)
  }

  async stream(command: string, signal?: AbortSignal): Promise<NodeJS.ReadableStream> {
    this.streamLog.push(command)
    if (signal?.aborted) throw new Error('Operation aborted')
    const handler = this.streamHandlers.shift()
    if (!handler) {
      return Readable.from([`no stream handler for: ${command}`])
    }
    return handler(command)
  }

  async tunnel(
    localPort: number,
    remoteHost: string,
    remotePort: number,
    _signal?: AbortSignal,
  ): Promise<TunnelHandle> {
    const handler = this.tunnelHandlers.shift()
    if (!handler) {
      return { localPort, close: () => {} }
    }
    return handler(localPort, remoteHost, remotePort)
  }

  close(): void {
    this.closed = true
  }
}

/** Create a FakeSshSession that always returns the given result. */
export function fakeSshSession(result: Partial<SshExecResult> = {}): FakeSshSession {
  return new FakeSshSession().onExec(() => ({
    stdout: '',
    stderr: '',
    code: 0,
    ...result,
  }))
}

/** Create a readable stream that emits the given chunks and ends. */
export function fakeReadable(chunks: string[]): NodeJS.ReadableStream {
  return Readable.from(chunks)
}
