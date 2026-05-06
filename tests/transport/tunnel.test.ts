// Tests for FakeSshSession.tunnel() and TunnelHandle contract.
// Full ssh2 forwardOut integration is covered by e2e tests.

import { describe, it, expect, vi } from 'vitest'
import { FakeSshSession } from '../helpers/ssh.js'
import type { TunnelHandle } from '../../src/transport/ssh.js'

describe('FakeSshSession.tunnel()', () => {
  it('returns a TunnelHandle with the requested localPort', async () => {
    const session = new FakeSshSession()
    const handle = await session.tunnel(18789, 'localhost', 18789)
    expect(handle.localPort).toBe(18789)
  })

  it('calls the registered onTunnel handler with correct args', async () => {
    const session = new FakeSshSession()
    const handler = vi.fn(
      (localPort: number, _remoteHost: string, _remotePort: number): TunnelHandle => ({
        localPort,
        close: vi.fn(),
      }),
    )
    session.onTunnel(handler)

    await session.tunnel(8080, 'localhost', 18789)

    expect(handler).toHaveBeenCalledWith(8080, 'localhost', 18789)
  })

  it('close() on the returned handle is callable', async () => {
    const session = new FakeSshSession()
    const closeFn = vi.fn()
    session.onTunnel(() => ({ localPort: 9000, close: closeFn }))

    const handle = await session.tunnel(9000, 'localhost', 9000)
    handle.close()

    expect(closeFn).toHaveBeenCalledOnce()
  })

  it('returns no-op handle when no handler is registered', async () => {
    const session = new FakeSshSession()
    const handle = await session.tunnel(3000, 'localhost', 3000)
    expect(handle.localPort).toBe(3000)
    expect(() => handle.close()).not.toThrow()
  })

  it('consumes handlers in FIFO order', async () => {
    const session = new FakeSshSession()
    const first = vi.fn((): TunnelHandle => ({ localPort: 1, close: vi.fn() }))
    const second = vi.fn((): TunnelHandle => ({ localPort: 2, close: vi.fn() }))
    session.onTunnel(first).onTunnel(second)

    const h1 = await session.tunnel(1, 'localhost', 1)
    const h2 = await session.tunnel(2, 'localhost', 2)

    expect(h1.localPort).toBe(1)
    expect(h2.localPort).toBe(2)
    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()
  })
})
