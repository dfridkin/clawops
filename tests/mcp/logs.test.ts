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

beforeEach(async () => {
  vi.clearAllMocks()
  const { buildContext, resolveConn } = await getMocks()
  buildContext.mockReturnValue(makeFakeContext())
  resolveConn.mockResolvedValue(FAKE_CONN)
})

describe('handleLogsTail', () => {
  it('returns log output from exec', async () => {
    const session = new FakeSshSession()
    session.onExec(() => ({ stdout: 'log line 1\nlog line 2\n', stderr: '', code: 0 }))
    const { acquireSession } = await getMocks()
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const { handleLogsTail } = await import('../../src/mcp/tools/cli/logs.js')
    const result = await handleLogsTail({ stackName: 'default', tailLines: 10 }, FAKE_SERVER)

    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(text).toContain('log line 1')
    expect(result.isError).toBeFalsy()
  })

  it('returns errText when exec fails with no stdout', async () => {
    const session = new FakeSshSession()
    session.onExec(() => ({ stdout: '', stderr: 'service not found', code: 1 }))
    const { acquireSession } = await getMocks()
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const { handleLogsTail } = await import('../../src/mcp/tools/cli/logs.js')
    const result = await handleLogsTail({ stackName: 'default', tailLines: 10 }, FAKE_SERVER)
    expect(result.isError).toBe(true)
  })

  it('truncates output larger than 8KB', async () => {
    const bigOutput = 'x'.repeat(9000)
    const session = new FakeSshSession()
    session.onExec(() => ({ stdout: bigOutput, stderr: '', code: 0 }))
    const { acquireSession } = await getMocks()
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const { handleLogsTail } = await import('../../src/mcp/tools/cli/logs.js')
    const result = await handleLogsTail({ stackName: 'default', tailLines: 100 }, FAKE_SERVER)

    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(text.length).toBeLessThan(9000)
    expect(text).toContain('truncated')
  })

  it('returns "(no log output)" when stdout is empty', async () => {
    const session = new FakeSshSession()
    session.onExec(() => ({ stdout: '', stderr: '', code: 0 }))
    const { acquireSession } = await getMocks()
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const { handleLogsTail } = await import('../../src/mcp/tools/cli/logs.js')
    const result = await handleLogsTail({ stackName: 'default', tailLines: 10 }, FAKE_SERVER)
    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(text).toBe('(no log output)')
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
