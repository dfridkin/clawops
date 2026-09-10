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
vi.mock('../../src/mcp/progress.js', () => ({ getTask: vi.fn() }))

const FAKE_SERVER = {} as McpServer

async function getMocks() {
  const { buildContext } = await import('../../src/cli/context.js')
  const { acquireSession } = await import('../../src/transport/pool.js')
  const { resolveConn } = await import('../../src/mcp/tools/_conn.js')
  const { getTask } = await import('../../src/mcp/progress.js')
  return {
    buildContext: vi.mocked(buildContext),
    acquireSession: vi.mocked(acquireSession),
    resolveConn: vi.mocked(resolveConn),
    getTask: vi.mocked(getTask),
  }
}

/**
 * A host whose gateway answers `openclaw logs`. The probe runs first, so a queued handler
 * would be consumed by it — these match on the command instead.
 */
function gatewayUp(stdout: string, code = 0): FakeSshSession {
  // Registered broad-first: `respond` lets the LAST matcher win, so the specific probe
  // pattern has to come after the general one or the general one swallows it.
  return new FakeSshSession()
    .respond(/openclaw logs/, { stdout, stderr: code === 0 ? '' : 'err', code })
    .respond(/openclaw logs --limit 1 >/, { stdout: 'ok' })
}

/** A host whose gateway is not answering, so only container output is available. */
function gatewayDown(stdout: string, code = 0): FakeSshSession {
  return new FakeSshSession()
    .respond(/docker logs/, { stdout, stderr: code === 0 ? '' : 'err', code })
    .respond(/openclaw logs --limit 1 >/, { stdout: 'no' })
}

beforeEach(async () => {
  vi.clearAllMocks()
  const { buildContext, resolveConn } = await getMocks()
  buildContext.mockReturnValue(makeFakeContext())
  resolveConn.mockResolvedValue(FAKE_CONN)
})

describe('handleLogsTail', () => {
  it('returns log output from exec', async () => {
    const session = gatewayUp('log line 1\nlog line 2\n')
    const { acquireSession } = await getMocks()
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const { handleLogsTail } = await import('../../src/mcp/tools/cli/logs.js')
    const result = await handleLogsTail({ stackName: 'default', tailLines: 10 }, FAKE_SERVER)

    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(text).toContain('log line 1')
    expect(result.isError).toBeFalsy()
  })

  it('returns errText when exec fails with no stdout', async () => {
    const session = gatewayUp('', 1)
    const { acquireSession } = await getMocks()
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const { handleLogsTail } = await import('../../src/mcp/tools/cli/logs.js')
    const result = await handleLogsTail({ stackName: 'default', tailLines: 10 }, FAKE_SERVER)
    expect(result.isError).toBe(true)
  })

  it('truncates output larger than 8KB', async () => {
    const bigOutput = 'x'.repeat(9000)
    const session = gatewayUp(bigOutput)
    const { acquireSession } = await getMocks()
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const { handleLogsTail } = await import('../../src/mcp/tools/cli/logs.js')
    const result = await handleLogsTail({ stackName: 'default', tailLines: 100 }, FAKE_SERVER)

    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(text.length).toBeLessThan(9000)
    expect(text).toContain('truncated')
  })

  it('returns "(no log output)" when stdout is empty', async () => {
    const session = gatewayUp('')
    const { acquireSession } = await getMocks()
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const { handleLogsTail } = await import('../../src/mcp/tools/cli/logs.js')
    const result = await handleLogsTail({ stackName: 'default', tailLines: 10 }, FAKE_SERVER)
    const text = (result.content[0] as { type: 'text'; text: string }).text
    // The source is part of the answer now: an empty result from a gateway that was
    // asked reads differently from one that was never reachable.
    expect(text).toContain('(no log output)')
    expect(text).toContain('gateway')
  })
})

describe('handleTaskStatus', () => {
  it('returns not_found with isError when taskId is unknown', async () => {
    const { getTask } = await getMocks()
    getTask.mockReturnValue(undefined)

    const { handleTaskStatus } = await import('../../src/mcp/tools/cli/task.js')
    const result = await handleTaskStatus({ taskId: 'nonexistent-id' }, FAKE_SERVER)

    expect(result.isError).toBe(true)
    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(JSON.parse(text).status).toBe('not_found')
  })

  it('returns task record when taskId is known', async () => {
    const fakeTask = {
      id: 'abc-123',
      status: 'running' as const,
      description: 'clawops_up stack=default',
      startedAt: '2026-05-07T00:00:00.000Z',
      updatedAt: '2026-05-07T00:00:00.000Z',
    }
    const { getTask } = await getMocks()
    getTask.mockReturnValue(fakeTask)

    const { handleTaskStatus } = await import('../../src/mcp/tools/cli/task.js')
    const result = await handleTaskStatus({ taskId: 'abc-123' }, FAKE_SERVER)

    expect(result.isError).toBeFalsy()
    const text = (result.content[0] as { type: 'text'; text: string }).text
    const parsed = JSON.parse(text)
    expect(parsed.status).toBe('running')
  })
})

describe('handleLogsTail — which log source answered', () => {
  it('reads the gateway when it is answering', async () => {
    const session = gatewayUp('structured line\n')
    const { acquireSession } = await getMocks()
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const { handleLogsTail } = await import('../../src/mcp/tools/cli/logs.js')
    const result = await handleLogsTail({ stackName: 'default', tailLines: 10 }, FAKE_SERVER)

    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(text).toContain('source: gateway')
    expect(session.execCalls().some((c) => c.includes('openclaw logs --limit 10'))).toBe(true)
  })

  it('falls back to container output when the gateway is not answering, and says so', async () => {
    // The old command chained `journalctl … || docker logs` and printed neither name, so an
    // agent could not tell an empty gateway from a source that was never read.
    const session = gatewayDown('container line\n')
    const { acquireSession } = await getMocks()
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const { handleLogsTail } = await import('../../src/mcp/tools/cli/logs.js')
    const result = await handleLogsTail({ stackName: 'default', tailLines: 10 }, FAKE_SERVER)

    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(text).toContain('source: container')
    expect(text).toContain('not answering')
    expect(text).toContain('container line')
  })

  it('never runs journalctl, which only the local provider has a unit for', async () => {
    const session = gatewayUp('x\n')
    const { acquireSession } = await getMocks()
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const { handleLogsTail } = await import('../../src/mcp/tools/cli/logs.js')
    await handleLogsTail({ stackName: 'default', tailLines: 10 }, FAKE_SERVER)

    expect(session.execCalls().join(' ')).not.toContain('journalctl')
  })

  it('uses container output for a time filter the gateway command cannot honour', async () => {
    // `openclaw logs` has no --since. Serving it from the gateway would silently ignore the
    // window the caller asked for.
    const session = gatewayDown('windowed\n')
    const { acquireSession } = await getMocks()
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const { handleLogsTail } = await import('../../src/mcp/tools/cli/logs.js')
    const result = await handleLogsTail({ stackName: 'default', tailLines: 10, sinceMin: 5 }, FAKE_SERVER)

    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(text).toContain('source: container')
    expect(session.execCalls().some((c) => c.includes("--since '5m'"))).toBe(true)
    // And it does not waste a round trip probing a gateway it will not use.
    expect(session.execCalls().some((c) => c.includes('--limit 1 >'))).toBe(false)
  })
})
