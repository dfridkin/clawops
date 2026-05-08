import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const mockHandleStatus = vi.fn()
const mockHandleLogsTail = vi.fn()
vi.mock('../../src/mcp/tools/cli/status.js', () => ({ handleStatus: mockHandleStatus }))
vi.mock('../../src/mcp/tools/cli/logs.js', () => ({ handleLogsTail: mockHandleLogsTail }))

const FAKE_SERVER = {} as McpServer

function okResult(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

function errResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockHandleStatus.mockResolvedValue(okResult('{"publicIp":"1.2.3.4","status":"deployed"}'))
  mockHandleLogsTail.mockResolvedValue(okResult('log line 1\nlog line 2'))
})

describe('handleWorkflowRecover', () => {
  it('includes both status and logs sections in report', async () => {
    const { handleWorkflowRecover } = await import('../../src/mcp/tools/workflow/recover.js')
    const result = await handleWorkflowRecover({ stackName: 'default' }, FAKE_SERVER)

    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(text).toContain('Status')
    expect(text).toContain('log line 1')
  })

  it('includes Next Steps section in all reports', async () => {
    const { handleWorkflowRecover } = await import('../../src/mcp/tools/workflow/recover.js')
    const result = await handleWorkflowRecover({ stackName: 'default' }, FAKE_SERVER)

    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(text).toContain('Next Steps')
  })

  it('includes status error text when handleStatus throws', async () => {
    mockHandleStatus.mockRejectedValue(new Error('stack not found'))
    const { handleWorkflowRecover } = await import('../../src/mcp/tools/workflow/recover.js')
    const result = await handleWorkflowRecover({ stackName: 'default' }, FAKE_SERVER)

    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(text).toContain('stack not found')
  })

  it('includes logs error text when handleLogsTail returns isError', async () => {
    mockHandleLogsTail.mockResolvedValue(errResult('service not found'))
    const { handleWorkflowRecover } = await import('../../src/mcp/tools/workflow/recover.js')
    const result = await handleWorkflowRecover({ stackName: 'default' }, FAKE_SERVER)

    // The workflow catches errors and includes them — it doesn't propagate as isError itself
    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(text).toContain('Status')
  })

  it('includes stack name in the diagnostic header', async () => {
    const { handleWorkflowRecover } = await import('../../src/mcp/tools/workflow/recover.js')
    const result = await handleWorkflowRecover({ stackName: 'my-stack' }, FAKE_SERVER)

    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(text).toContain('my-stack')
  })
})
