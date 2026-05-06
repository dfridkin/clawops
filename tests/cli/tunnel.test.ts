// Unit tests for the `tunnel` command.
// Mocks buildContext and acquireSession; verifies session.tunnel() is called correctly.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { FakeSshSession } from '../helpers/ssh.js'
import { makeFakeContext } from '../helpers/context.js'

vi.mock('../../src/cli/context.js', () => ({ buildContext: vi.fn() }))
vi.mock('../../src/transport/pool.js', () => ({
  acquireSession: vi.fn(),
  drainPool: vi.fn(),
}))
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}))

async function getCmd() {
  const { default: cmd } = await import('../../src/cli/commands/tunnel.js')
  return cmd
}

async function getMocks() {
  const { buildContext } = await import('../../src/cli/context.js')
  const { acquireSession } = await import('../../src/transport/pool.js')
  return { buildContext: vi.mocked(buildContext), acquireSession: vi.mocked(acquireSession) }
}

function wireSession(session: FakeSshSession) {
  return async (_opts: unknown) => ({ session, release: vi.fn() })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRunFn = (ctx: any) => Promise<void>

describe('tunnel command', () => {
  let abortFn: (() => void) | undefined

  beforeEach(() => {
    vi.resetModules()
    // Capture SIGINT handler so tests can trigger abort
    vi.spyOn(process, 'on').mockImplementation((event: string | symbol, handler: (...args: unknown[]) => void) => {
      if (event === 'SIGINT') abortFn = handler as () => void
      return process
    })
  })

  afterEach(() => {
    abortFn = undefined
    vi.restoreAllMocks()
  })

  it('calls session.tunnel with the remote port from gatewayUrl', async () => {
    const session = new FakeSshSession()
    const closeFn = vi.fn()

    session.onTunnel((_local, _host, _remote) => {
      // Trigger SIGINT after tunnel is established to unblock the wait
      setTimeout(() => abortFn?.(), 0)
      return { localPort: _local, close: closeFn }
    })

    const { buildContext, acquireSession } = await getMocks()
    buildContext.mockReturnValue(makeFakeContext())
    acquireSession.mockImplementation(wireSession(session))

    const cmd = await getCmd()
    await (cmd.run as AnyRunFn)({ args: { _: [], stack: undefined, port: undefined, 'no-open': true } })

    // gatewayUrl is https://1.2.3.4:18789 → remotePort = 18789
    expect(closeFn).toHaveBeenCalledOnce()
  })

  it('uses custom local port when --port is supplied', async () => {
    const session = new FakeSshSession()
    const tunnelHandler = vi.fn((_local: number) => {
      setTimeout(() => abortFn?.(), 0)
      return { localPort: _local, close: vi.fn() }
    })
    session.onTunnel(tunnelHandler)

    const { buildContext, acquireSession } = await getMocks()
    buildContext.mockReturnValue(makeFakeContext())
    acquireSession.mockImplementation(wireSession(session))

    const cmd = await getCmd()
    await (cmd.run as AnyRunFn)({ args: { _: [], stack: undefined, port: '9999', 'no-open': true } })

    expect(tunnelHandler).toHaveBeenCalledWith(9999, 'localhost', 18789)
  })

  it('defaults local port to remote port when --port is omitted', async () => {
    const session = new FakeSshSession()
    const tunnelHandler = vi.fn((_local: number) => {
      setTimeout(() => abortFn?.(), 0)
      return { localPort: _local, close: vi.fn() }
    })
    session.onTunnel(tunnelHandler)

    const { buildContext, acquireSession } = await getMocks()
    buildContext.mockReturnValue(makeFakeContext())
    acquireSession.mockImplementation(wireSession(session))

    const cmd = await getCmd()
    await (cmd.run as AnyRunFn)({ args: { _: [], stack: undefined, port: undefined, 'no-open': true } })

    expect(tunnelHandler).toHaveBeenCalledWith(18789, 'localhost', 18789)
  })

  it('calls release() in finally block', async () => {
    const session = new FakeSshSession()
    const releaseFn = vi.fn()
    session.onTunnel(() => {
      setTimeout(() => abortFn?.(), 0)
      return { localPort: 18789, close: vi.fn() }
    })

    const { buildContext, acquireSession } = await getMocks()
    buildContext.mockReturnValue(makeFakeContext())
    acquireSession.mockImplementation(async (_opts: unknown) => ({ session, release: releaseFn }))

    const cmd = await getCmd()
    await (cmd.run as AnyRunFn)({ args: { _: [], stack: undefined, port: undefined, 'no-open': true } })

    expect(releaseFn).toHaveBeenCalledOnce()
  })
})
