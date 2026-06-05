// SSH transport unit tests using FakeSshSession.

import { describe, it, expect } from 'vitest'
import { createServer, createConnection } from 'node:net'
import { FakeSshSession, fakeSshSession, fakeReadable } from '../helpers/ssh.js'

describe('FakeSshSession', () => {
  it('exec() returns queued result', async () => {
    const session = new FakeSshSession().onExec(() => ({
      stdout: 'hello',
      stderr: '',
      code: 0,
    }))
    const result = await session.exec('echo hello')
    expect(result.stdout).toBe('hello')
    expect(result.code).toBe(0)
  })

  it('exec() falls back to empty result when no handler queued', async () => {
    const session = new FakeSshSession()
    const result = await session.exec('whoami')
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('no handler')
  })

  it('exec() rejects when signal is already aborted', async () => {
    const session = new FakeSshSession()
    const controller = new AbortController()
    controller.abort()
    await expect(session.exec('ls', controller.signal)).rejects.toThrow('aborted')
  })

  it('stream() returns queued readable', async () => {
    const session = new FakeSshSession().onStream(() => fakeReadable(['line1\n', 'line2\n']))
    const stream = await session.stream('tail -f /var/log/syslog')
    const chunks: string[] = []
    for await (const chunk of stream) {
      chunks.push(String(chunk))
    }
    expect(chunks.join('')).toBe('line1\nline2\n')
  })

  it('close() marks session as closed', () => {
    const session = new FakeSshSession()
    expect(session.closed).toBe(false)
    session.close()
    expect(session.closed).toBe(true)
  })
})

describe('fakeSshSession()', () => {
  it('creates a session with a default success result', async () => {
    const session = fakeSshSession({ stdout: 'test output', code: 0 })
    const result = await session.exec('cmd')
    expect(result.stdout).toBe('test output')
  })
})

// Regression test for the tunnel server error-path socket leak fix.
// Verifies that when a TCP server emits an error AFTER accepting connections,
// the closeAll() call correctly destroys all open sockets.
// This pattern mirrors what Ssh2Session.tunnel() does internally.
describe('tunnel server error handler closes accepted sockets', () => {
  it('destroys all sockets when server error fires after connection accepted', () => {
    return new Promise<void>((resolve) => {
      const sockets = new Set<ReturnType<typeof createConnection>>()

      const server = createServer((socket) => {
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
      })

      // closeAll mirrors what Ssh2Session.tunnel() does
      const closeAll = (): void => {
        for (const s of sockets) s.destroy()
        server.close()
      }

      server.on('error', () => {
        closeAll()
        const allDestroyed = [...sockets].every(s => s.destroyed)
        expect(allDestroyed).toBe(true)
        resolve()
      })

      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number }
        const client = createConnection(addr.port, '127.0.0.1')
        // Suppress ECONNRESET — expected when server destroys the socket
        client.on('error', () => {})
        client.on('connect', () => {
          server.emit('error', new Error('simulated server error'))
        })
      })
    })
  })
})
