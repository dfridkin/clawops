import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { FakeSshSession } from '../helpers/ssh.js'
import { FAKE_CONN } from '../helpers/context.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

vi.mock('../../src/cli/context.js', () => ({ buildContext: vi.fn() }))
vi.mock('../../src/transport/pool.js', () => ({ acquireSession: vi.fn(), drainPool: vi.fn() }))
// trimForMcp persists the full output under CLAWOPS_HOME; keep it out of the real one.
const home = mkdtempSync(path.join(tmpdir(), 'clawops-mcp-agents-'))
process.env['CLAWOPS_HOME'] = home
afterAll(() => rmSync(home, { recursive: true, force: true }))
vi.mock('../../src/mcp/tools/_conn.js', () => ({ resolveConn: vi.fn(), okText: vi.fn(t => ({ content: [{ type: 'text', text: t }] })), errText: vi.fn(t => ({ content: [{ type: 'text', text: t }], isError: true })) }))

function makeServer(action: 'accept' | 'decline' = 'accept', confirmed = true): McpServer {
  return {
    server: {
      getClientCapabilities: () => ({ elicitation: {} }),
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

  it('reports a failed listing instead of returning an empty list', async () => {
    // The command used to end in `|| echo "[]"`, so a stopped container, a gateway still
    // starting, or a docker permission error all came back as "no agents" — a wrong
    // answer an agent then acts on, rather than an error it can report.
    const session = new FakeSshSession()
    session.onExec(() => ({ stdout: '', stderr: 'Error: No such container: openclaw', code: 1 }))
    const { acquireSession } = await getMocks()
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const { handleAgentsList } = await import('../../src/mcp/tools/cli/agents.js')
    const result = await handleAgentsList({ stackName: 'default' }, makeServer())

    expect(result.isError).toBe(true)
    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(text).toMatch(/No such container/)
    expect(text).not.toBe('[]')
  })

  it('does not fold stderr into the JSON it returns', async () => {
    // `2>&1` put error text on stdout, where it was returned as though it were the list.
    const session = new FakeSshSession()
    session.onExec(() => ({ stdout: '[]', stderr: '', code: 0 }))
    const { acquireSession } = await getMocks()
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const { handleAgentsList } = await import('../../src/mcp/tools/cli/agents.js')
    await handleAgentsList({ stackName: 'default' }, makeServer())

    expect(session.execCalls().join(' ')).not.toContain('2>&1')
    expect(session.execCalls().join(' ')).not.toContain('echo "[]"')
  })

  it('returns an empty list when the deployment genuinely has no agents', async () => {
    const session = new FakeSshSession()
    session.onExec(() => ({ stdout: '[]', stderr: '', code: 0 }))
    const { acquireSession } = await getMocks()
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const { handleAgentsList } = await import('../../src/mcp/tools/cli/agents.js')
    const result = await handleAgentsList({ stackName: 'default' }, makeServer())

    expect(result.isError).toBeFalsy()
    expect((result.content[0] as { type: 'text'; text: string }).text).toBe('[]')
  })

})

describe('handleAgentsLogs', () => {
  // Same query and same failure words as `clawops agents logs` (src/openclaw/agent-activity.ts).
  const PAGE = {
    records: [
      { at: '2026-09-10T04:00:00Z', status: 'succeeded', summary: 'ran a thing' },
      { at: '2026-09-10T04:01:00Z', status: 'failed', summary: 'did not' },
    ],
    cursor: 'next-abc',
  }

  async function wireLogs(session: FakeSshSession) {
    const { acquireSession } = await getMocks()
    acquireSession.mockResolvedValue({ session, release: vi.fn() })
  }

  function body(result: { content: unknown[] }) {
    return JSON.parse((result.content[0] as { type: 'text'; text: string }).text) as {
      agent: string; cursor?: string; count: number; records: Array<{ summary?: string }>
    }
  }

  it('refuses an empty agent name before connecting', async () => {
    const { acquireSession } = await getMocks()
    acquireSession.mockClear()
    const { handleAgentsLogs } = await import('../../src/mcp/tools/cli/agents.js')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await handleAgentsLogs({ name: '', limit: 50 } as any, {} as any)

    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toMatch(/name is required/)
    expect(acquireSession).not.toHaveBeenCalled()
  })

  it('reads the agent audit log and returns the cursor for the next page', async () => {
    const session = new FakeSshSession().respond(/audit/, { stdout: JSON.stringify(PAGE) })
    await wireLogs(session)

    const { handleAgentsLogs } = await import('../../src/mcp/tools/cli/agents.js')
    const result = await handleAgentsLogs({ stackName: 'default', name: 'claude', limit: 50 }, makeServer())

    expect(result.isError).toBeFalsy()
    const page = body(result)
    expect(page.agent).toBe('claude')
    expect(page.cursor).toBe('next-abc')
    expect(page.records.map((r) => r.summary)).toEqual(['ran a thing', 'did not'])
    const call = session.execCalls().find((c) => c.includes('audit'))!
    expect(call).toContain("--agent 'claude'")
    expect(call).toContain('--kind agent_run')
    expect(session.execCalls().join(' ')).not.toContain('agents logs')
  })

  it('passes limit and cursor through, so a returned cursor continues the query', async () => {
    const session = new FakeSshSession().respond(/audit/, { stdout: JSON.stringify({ records: [] }) })
    await wireLogs(session)

    const { handleAgentsLogs } = await import('../../src/mcp/tools/cli/agents.js')
    const result = await handleAgentsLogs(
      { stackName: 'default', name: 'claude', limit: 5, cursor: 'next-abc' },
      makeServer(),
    )

    const call = session.execCalls().find((c) => c.includes('audit'))!
    // A regex, not toContain: '--limit 50' contains '--limit 5', and the default would pass.
    expect(call).toMatch(/--limit 5(\s|$)/)
    expect(call).toContain("--cursor 'next-abc'")
    // The last page carries no cursor, and none is invented.
    expect(body(result)).not.toHaveProperty('cursor')
    expect(body(result).count).toBe(0)
  })

  it('defaults to 50 records when no limit is given', async () => {
    const session = new FakeSshSession().respond(/audit/, { stdout: '{"records":[]}' })
    await wireLogs(session)

    const { handleAgentsLogs } = await import('../../src/mcp/tools/cli/agents.js')
    await handleAgentsLogs({ name: 'claude' } as never, makeServer())

    expect(session.execCalls().find((c) => c.includes('audit'))).toMatch(/--limit 50(\s|$)/)
  })

  it('reports a failed query in the CLI\'s words instead of an empty page', async () => {
    const session = new FakeSshSession().respond(/audit/, { stderr: 'no such agent', code: 1 })
    await wireLogs(session)

    const { handleAgentsLogs } = await import('../../src/mcp/tools/cli/agents.js')
    const result = await handleAgentsLogs({ stackName: 'default', name: 'ghost', limit: 50 }, makeServer())

    expect(result.isError).toBe(true)
    expect((result.content[0] as { type: 'text'; text: string }).text).toBe('Cannot read activity for "ghost": no such agent')
  })

  it('keeps the cursor when a large page is cut to 8KB (R14)', async () => {
    const big = {
      records: Array.from({ length: 200 }, (_, i) => ({ at: `t${i}`, status: 'succeeded', summary: 'x'.repeat(80) })),
      cursor: 'deep-cursor',
    }
    const session = new FakeSshSession().respond(/audit/, { stdout: JSON.stringify(big) })
    await wireLogs(session)

    const { handleAgentsLogs } = await import('../../src/mcp/tools/cli/agents.js')
    const result = await handleAgentsLogs({ stackName: 'default', name: 'claude', limit: 200 }, makeServer())

    const out = (result.content[0] as { type: 'text'; text: string }).text
    expect(out).toContain('[Output truncated at 8KB')
    expect(Buffer.byteLength(out)).toBeLessThan(8 * 1024 + 200)
    expect(out).toContain('"cursor": "deep-cursor"')
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
