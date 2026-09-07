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

describe('clawops_agents_restart is gone', () => {
  it('is not declared in spec/mcp-tools.yaml', async () => {
    // Removed rather than widened: OpenClaw 2.0 has no per-agent restart, and the
    // gateway-wide one is already clawops_gateway_restart. A destructiveHint tool whose
    // name implies agent scope but restarts every agent on the host is the sharp edge
    // here — a human reads a deprecation notice, an agent routinely does not.
    //
    // Asserted against the spec because spec/mcp-tools.yaml is the source of truth and
    // _generated.ts is built from it (R-meta-1).
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const spec = readFileSync(resolve(import.meta.dirname, '../../spec/mcp-tools.yaml'), 'utf8')
    expect(spec).not.toContain('name: clawops_agents_restart')
    expect(spec).toContain('name: clawops_gateway_restart')
  })

  it('has no generated schema and no handler', async () => {
    const generated = await import('../../src/mcp/tools/_generated.js')
    expect(generated).not.toHaveProperty('clawops_agents_restartSchema')
    const handlers = await import('../../src/mcp/tools/cli/agents.js')
    expect(handlers).not.toHaveProperty('handleAgentsRestart')
  })
})
