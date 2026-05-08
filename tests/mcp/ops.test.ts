import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { makeFakeContext } from '../helpers/context.js'
import { FakeSshSession } from '../helpers/ssh.js'
import { FAKE_CONN } from '../helpers/context.js'

vi.mock('../../src/cli/context.js', () => ({ buildContext: vi.fn() }))
vi.mock('../../src/transport/pool.js', () => ({ acquireSession: vi.fn(), drainPool: vi.fn() }))
vi.mock('../../src/mcp/tools/_conn.js', () => ({
  resolveConn: vi.fn(),
  okText: vi.fn(t => ({ content: [{ type: 'text', text: t }] })),
  errText: vi.fn(t => ({ content: [{ type: 'text', text: t }], isError: true })),
}))
vi.mock('../../src/mcp/progress.js', () => ({
  startTask: vi.fn(),
  updateTask: vi.fn(),
  makeProgressEmitter: vi.fn(() => () => {}),
}))
vi.mock('../../src/mcp/tools/_trim.js', () => ({
  trimForMcp: vi.fn((s: string) => ({ content: s, truncated: false })),
}))

function makeServer(action: 'accept' | 'decline' = 'accept', confirmed = true): McpServer {
  return {
    server: {
      elicitInput: vi.fn().mockResolvedValue({ action, content: { confirmed } }),
      notification: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as McpServer
}

function makeCloudContext() {
  const ctx = makeFakeContext()
  const stack = {
    setConfig: vi.fn().mockResolvedValue(undefined),
    up: vi.fn().mockResolvedValue({
      outputs: { publicIp: { value: '1.2.3.4' }, gatewayUrl: { value: 'https://gw' } },
      summary: { resourceChanges: { create: 1 } },
    }),
    preview: vi.fn().mockResolvedValue({ changeSummary: { create: 1 } }),
    destroy: vi.fn().mockResolvedValue(undefined),
  }
  return { ctx, stack }
}

async function getMocks() {
  const { buildContext } = await import('../../src/cli/context.js')
  const { acquireSession } = await import('../../src/transport/pool.js')
  const { resolveConn } = await import('../../src/mcp/tools/_conn.js')
  return {
    buildContext: vi.mocked(buildContext),
    acquireSession: vi.mocked(acquireSession),
    resolveConn: vi.mocked(resolveConn),
  }
}

beforeEach(async () => {
  vi.clearAllMocks()
  const { resolveConn } = await getMocks()
  resolveConn.mockResolvedValue(FAKE_CONN)
})

describe('handleUp', () => {
  it('returns cancelled when elicitation is declined', async () => {
    const { buildContext } = await getMocks()
    const { ctx, stack } = makeCloudContext()
    buildContext.mockReturnValue({ ...ctx, getStack: vi.fn().mockResolvedValue(stack) })

    const { handleUp } = await import('../../src/mcp/tools/cli/up.js')
    const result = await handleUp({ instanceType: 'small', dryRun: false }, makeServer('decline'))
    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(text).toMatch(/cancel/i)
  })

  it('calls stack.up() and returns summary when confirmed', async () => {
    const { buildContext } = await getMocks()
    const { ctx, stack } = makeCloudContext()
    buildContext.mockReturnValue({ ...ctx, getStack: vi.fn().mockResolvedValue(stack) })

    const { handleUp } = await import('../../src/mcp/tools/cli/up.js')
    await handleUp({ instanceType: 'small', dryRun: false }, makeServer())
    expect(stack.up).toHaveBeenCalledOnce()
  })

  it('runs preview (not up) when dryRun=true', async () => {
    const { buildContext } = await getMocks()
    const { ctx, stack } = makeCloudContext()
    buildContext.mockReturnValue({ ...ctx, getStack: vi.fn().mockResolvedValue(stack) })

    const { handleUp } = await import('../../src/mcp/tools/cli/up.js')
    await handleUp({ instanceType: 'small', dryRun: true }, makeServer())
    expect(stack.preview).toHaveBeenCalledOnce()
    expect(stack.up).not.toHaveBeenCalled()
  })

  it('skips elicitation when dryRun=true', async () => {
    const { buildContext } = await getMocks()
    const { ctx, stack } = makeCloudContext()
    buildContext.mockReturnValue({ ...ctx, getStack: vi.fn().mockResolvedValue(stack) })

    const server = makeServer()
    const { handleUp } = await import('../../src/mcp/tools/cli/up.js')
    await handleUp({ instanceType: 'small', dryRun: true }, server)
    expect(server.server.elicitInput).not.toHaveBeenCalled()
  })
})

describe('handleDestroy', () => {
  it('returns cancelled when elicitation is declined', async () => {
    const { buildContext } = await getMocks()
    const { ctx, stack } = makeCloudContext()
    buildContext.mockReturnValue({ ...ctx, getStack: vi.fn().mockResolvedValue(stack) })

    const { handleDestroy } = await import('../../src/mcp/tools/cli/destroy.js')
    const result = await handleDestroy({ stackName: 'default', yes: false }, makeServer('decline'))
    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(text).toMatch(/cancel/i)
    expect(stack.destroy).not.toHaveBeenCalled()
  })

  it('calls stack.destroy() when accepted', async () => {
    const { buildContext } = await getMocks()
    const { ctx, stack } = makeCloudContext()
    buildContext.mockReturnValue({ ...ctx, getStack: vi.fn().mockResolvedValue(stack) })

    const { handleDestroy } = await import('../../src/mcp/tools/cli/destroy.js')
    await handleDestroy({ stackName: 'default', yes: false }, makeServer())
    expect(stack.destroy).toHaveBeenCalledOnce()
  })

  it('skips elicitation when yes=true', async () => {
    const { buildContext } = await getMocks()
    const { ctx, stack } = makeCloudContext()
    buildContext.mockReturnValue({ ...ctx, getStack: vi.fn().mockResolvedValue(stack) })

    const server = makeServer()
    const { handleDestroy } = await import('../../src/mcp/tools/cli/destroy.js')
    await handleDestroy({ stackName: 'default', yes: true }, server)
    expect(server.server.elicitInput).not.toHaveBeenCalled()
    expect(stack.destroy).toHaveBeenCalledOnce()
  })

  it('returns errText for local provider', async () => {
    const { buildContext } = await getMocks()
    buildContext.mockReturnValue(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { ...makeFakeContext(), adapter: { name: 'local' } } as any,
    )

    const { handleDestroy } = await import('../../src/mcp/tools/cli/destroy.js')
    const result = await handleDestroy({ stackName: 'default', yes: true }, makeServer())
    expect(result.isError).toBe(true)
  })
})

describe('handleGatewayRestart', () => {
  it('returns cancelled when declined', async () => {
    const { handleGatewayRestart } = await import('../../src/mcp/tools/cli/gateway.js')
    const result = await handleGatewayRestart({ stackName: 'default' }, makeServer('decline'))
    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(text).toMatch(/cancel/i)
  })

  it('runs docker restart commands when accepted', async () => {
    const { buildContext, acquireSession } = await getMocks()
    buildContext.mockReturnValue(makeFakeContext())

    const session = new FakeSshSession()
    session.onExec(() => ({ stdout: 'ghcr.io/openclaw/openclaw:stable', stderr: '', code: 0 }))
    session.onExec(() => ({ stdout: '', stderr: '', code: 0 }))
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const { handleGatewayRestart } = await import('../../src/mcp/tools/cli/gateway.js')
    const result = await handleGatewayRestart({ stackName: 'default' }, makeServer())
    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(text).toMatch(/restart/i)
    expect(result.isError).toBeFalsy()
  })

  it('returns errText when restart command fails', async () => {
    const { buildContext, acquireSession } = await getMocks()
    buildContext.mockReturnValue(makeFakeContext())

    const session = new FakeSshSession()
    session.onExec(() => ({ stdout: 'ghcr.io/openclaw/openclaw:stable', stderr: '', code: 0 }))
    session.onExec(() => ({ stdout: '', stderr: 'docker: error', code: 1 }))
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const { handleGatewayRestart } = await import('../../src/mcp/tools/cli/gateway.js')
    const result = await handleGatewayRestart({ stackName: 'default' }, makeServer())
    expect(result.isError).toBe(true)
  })
})
