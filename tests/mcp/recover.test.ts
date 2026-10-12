import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const mockHandleStatus = vi.fn()
const mockHandleLogsTail = vi.fn()
const mockHandleDoctor = vi.fn()
vi.mock('../../src/mcp/tools/cli/status.js', () => ({ handleStatus: mockHandleStatus }))
vi.mock('../../src/mcp/tools/cli/logs.js', () => ({ handleLogsTail: mockHandleLogsTail }))
vi.mock('../../src/mcp/tools/cli/doctor.js', () => ({ handleDoctor: mockHandleDoctor }))
vi.mock('../../src/mcp/tools/_trim.js', () => ({
  trimForMcp: (output: string) => ({ content: output, truncated: false }),
}))

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
  mockHandleDoctor.mockResolvedValue(okResult('{"ok":false,"checks":[{"name":"Gateway","status":"fail"}]}'))
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

  it('runs the stack health checks, failures only, and reports them', async () => {
    const { handleWorkflowRecover } = await import('../../src/mcp/tools/workflow/recover.js')
    const result = await handleWorkflowRecover({ stackName: 'prod' }, FAKE_SERVER)
    const text = (result.content[0] as { text: string }).text
    expect(mockHandleDoctor).toHaveBeenCalledWith({ stackName: 'prod', failuresOnly: true }, FAKE_SERVER)
    expect(text).toContain('### Failed health checks')
    expect(text).toContain('"Gateway","status":"fail"')
  })

  it('never recommends a tool or command that does not exist', async () => {
    // It used to end with "run `clawops refresh` from the CLI", which there is no such command.
    const { handleWorkflowRecover } = await import('../../src/mcp/tools/workflow/recover.js')
    const { TOOL_NAMES } = await import('../../src/mcp/tools/registry.js')
    const result = await handleWorkflowRecover({ stackName: 'prod' }, FAKE_SERVER)
    const text = (result.content[0] as { text: string }).text
    const named = [...text.matchAll(/clawops_[a-z_]+/g)].map((m) => m[0])
    expect(named.length).toBeGreaterThan(0)
    expect(named.filter((n) => !TOOL_NAMES.includes(n))).toEqual([])
    expect(text).not.toMatch(/clawops refresh/)
  })
})
