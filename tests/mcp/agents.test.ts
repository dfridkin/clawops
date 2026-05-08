import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { FakeSshSession } from '../helpers/ssh.js'
import { FAKE_CONN } from '../helpers/context.js'

vi.mock('../../src/cli/context.js', () => ({ buildContext: vi.fn() }))
vi.mock('../../src/transport/pool.js', () => ({ acquireSession: vi.fn(), drainPool: vi.fn() }))
vi.mock('../../src/mcp/tools/_conn.js', () => ({ resolveConn: vi.fn(), okText: vi.fn(t => ({ content: [{ type: 'text', text: t }] })), errText: vi.fn(t => ({ content: [{ type: 'text', text: t }], isError: true })) }))

function makeServer(action: 'accept' | 'decline' = 'accept', confirmed = true): McpServer {
  return {
    server: {
      elicitInput: vi.fn().mockResolvedValue({ action, content: { confirmed } }),
      notification: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as McpServer
}

async function getMocks() {
  const { buildContext } = await import('../../src/cli/context.js')
  const { acquireSession, drainPool } = await import('../../src/transport/pool.js')
  const { resolveConn } = await import('../../src/mcp/tools/_conn.js')
  return {
    buildContext: vi.mocked(buildContext),
    acquireSession: vi.mocked(acquireSession),
    drainPool: vi.mocked(drainPool),
    resolveConn: vi.mocked(resolveConn),
  }
}

beforeEach(async () => {
  vi.clearAllMocks()
  const { buildContext, resolveConn } = await getMocks()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  buildContext.mockReturnValue({ config: {} as any, stackName: 'default', adapter: { name: 'gcp' }, getStack: vi.fn() } as any)
  resolveConn.mockResolvedValue(FAKE_CONN)
})

describe('handleAgentsList', () => {
  it('returns exec stdout as ok text', async () => {
    const session = new FakeSshSession()
    session.onExec(() => ({ stdout: '[{"id":"agent-1"}]', stderr: '', code: 0 }))
    const { acquireSession } = await getMocks()
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const { handleAgentsList } = await import('../../src/mcp/tools/cli/agents.js')
    const result = await handleAgentsList({ stackName: 'default' }, makeServer())

    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(text).toContain('agent-1')
    expect(result.isError).toBeFalsy()
  })

  it('propagates errors from acquireSession', async () => {
    const { acquireSession } = await getMocks()
    acquireSession.mockRejectedValue(new Error('connection refused'))

    const { handleAgentsList } = await import('../../src/mcp/tools/cli/agents.js')
    await expect(handleAgentsList({ stackName: 'default' }, makeServer())).rejects.toThrow('connection refused')
  })
})

describe('handleAgentsRestart', () => {
  it('returns cancelled when elicitation is declined', async () => {
    const server = makeServer('decline')
    const { handleAgentsRestart } = await import('../../src/mcp/tools/cli/agents.js')
    const result = await handleAgentsRestart({ stackName: 'default', agentId: 'agent-1' }, server)
    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(text).toMatch(/cancel/)
  })

  it('calls exec with agentId when accepted', async () => {
    const session = new FakeSshSession()
    const execSpy = vi.fn().mockResolvedValue({ stdout: 'restarted', stderr: '', code: 0 })
    session.onExec(execSpy)
    const { acquireSession } = await getMocks()
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const { handleAgentsRestart } = await import('../../src/mcp/tools/cli/agents.js')
    await handleAgentsRestart({ stackName: 'default', agentId: 'agent-1' }, makeServer())

    expect(execSpy).toHaveBeenCalledWith(expect.stringContaining('agent-1'))
  })

  it('returns errText when exec exits non-zero', async () => {
    const session = new FakeSshSession()
    session.onExec(() => ({ stdout: '', stderr: 'not found', code: 1 }))
    const { acquireSession } = await getMocks()
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const { handleAgentsRestart } = await import('../../src/mcp/tools/cli/agents.js')
    const result = await handleAgentsRestart({ stackName: 'default', agentId: 'x' }, makeServer())
    expect(result.isError).toBe(true)
  })
})
