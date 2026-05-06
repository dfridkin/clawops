// FakeSshClient — in-process test double for SshSession.
// Use in unit tests that exercise SSH-dependent code without a real connection.

import type { SshSession, SshExecResult } from '../../src/transport/ssh.js'
import { Readable } from 'node:stream'

export type ExecHandler = (command: string) => SshExecResult | Promise<SshExecResult>
export type StreamHandler = (command: string) => NodeJS.ReadableStream

export class FakeSshSession implements SshSession {
  private execHandlers: ExecHandler[] = []
  private streamHandlers: StreamHandler[] = []
  closed = false

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

  async exec(command: string, signal?: AbortSignal): Promise<SshExecResult> {
    if (signal?.aborted) throw new Error('Operation aborted')
    const handler = this.execHandlers.shift()
    if (!handler) {
      return { stdout: '', stderr: `no handler for exec: ${command}`, code: 0 }
    }
    return handler(command)
  }

  async stream(command: string, signal?: AbortSignal): Promise<NodeJS.ReadableStream> {
    if (signal?.aborted) throw new Error('Operation aborted')
    const handler = this.streamHandlers.shift()
    if (!handler) {
      return Readable.from([`no stream handler for: ${command}`])
    }
    return handler(command)
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
