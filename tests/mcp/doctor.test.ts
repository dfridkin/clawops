import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const { mockRunDiagnostics, mockTrim } = vi.hoisted(() => ({
  mockRunDiagnostics: vi.fn(),
  mockTrim: vi.fn((content: string) => ({ content, truncated: false })),
}))
vi.mock('../../src/diagnostics/index.js', () => ({ runDiagnostics: mockRunDiagnostics }))
vi.mock('../../src/mcp/tools/_trim.js', () => ({ trimForMcp: mockTrim }))
vi.mock('../../src/mcp/tools/_conn.js', () => ({
  resolveConn: vi.fn(),
  okText: vi.fn((t: string) => ({ content: [{ type: 'text', text: t }] })),
  errText: vi.fn((t: string) => ({ content: [{ type: 'text', text: t }], isError: true })),
}))

const SERVER = {} as unknown as McpServer

const REPORT = {
  sections: [
    {
      title: 'Runtime',
      checks: [
        { name: 'Node.js', status: 'pass', detail: 'v22.0.0' },
        { name: 'Pulumi home', status: 'pass' },
      ],
    },
    {
      title: 'Remote health',
      checks: [
        { name: 'Gateway', status: 'fail', detail: 'no response from the gateway' },
        { name: 'Published', status: 'warn', detail: '0.0.0.0' },
        { name: 'Log rotation', status: 'info', detail: 'n/a' },
      ],
    },
  ],
  ok: false,
  counts: { pass: 2, fail: 1, warn: 1, info: 1 },
}

async function call(input: { stackName?: string; failuresOnly?: boolean }) {
  const { handleDoctor } = await import('../../src/mcp/tools/cli/doctor.js')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await handleDoctor(input as any, SERVER)
  const text = (result.content[0] as { type: 'text'; text: string }).text
  return JSON.parse(text) as typeof REPORT
}

beforeEach(() => {
  vi.clearAllMocks()
  mockTrim.mockImplementation((content: string) => ({ content, truncated: false }))
  mockRunDiagnostics.mockResolvedValue(REPORT)
})

describe('handleDoctor', () => {
  it('returns the whole report by default', async () => {
    const report = await call({ stackName: 'prod' })
    expect(report.sections).toHaveLength(2)
    expect(report.sections[0]!.checks).toHaveLength(2)
    expect(report.ok).toBe(false)
  })

  it('makes no remote connection when no stack is given', async () => {
    await call({})
    expect(mockRunDiagnostics).toHaveBeenCalledWith(
      expect.objectContaining({ stack: undefined }),
    )
  })

  it('keeps only failing and warning checks under failuresOnly', async () => {
    const report = await call({ stackName: 'prod', failuresOnly: true })
    const names = report.sections.flatMap((s) => s.checks.map((c) => c.name))
    expect(names).toEqual(['Gateway', 'Published'])
  })

  it('drops sections left empty by failuresOnly', async () => {
    const report = await call({ stackName: 'prod', failuresOnly: true })
    expect(report.sections.map((s) => s.title)).toEqual(['Remote health'])
  })

  it('keeps the full counts under failuresOnly, so nothing looks lost', async () => {
    const report = await call({ stackName: 'prod', failuresOnly: true })
    expect(report.counts).toEqual({ pass: 2, fail: 1, warn: 1, info: 1 })
  })

  it('does not recompute ok from the filtered view', async () => {
    // A report whose only non-passing checks are warnings is ok. Recomputing from what
    // survived the filter would report ok: false for a healthy deployment.
    mockRunDiagnostics.mockResolvedValue({
      sections: [{ title: 'SSH', checks: [{ name: 'known_hosts', status: 'warn' }] }],
      ok: true,
      counts: { pass: 0, fail: 0, warn: 1, info: 0 },
    })
    const report = await call({ failuresOnly: true })
    expect(report.sections).toHaveLength(1)
    expect(report.ok).toBe(true)
  })

  it('trims through the shared helper, under the stack name', async () => {
    await call({ stackName: 'prod' })
    expect(mockTrim).toHaveBeenCalledWith(expect.any(String), 'prod')
  })

  it('trims under a stable key when there is no stack', async () => {
    await call({})
    expect(mockTrim).toHaveBeenCalledWith(expect.any(String), 'local')
  })

  it('returns what the trim helper produced, not the raw report', async () => {
    // R14: the 8KB cap and the resource pointer both come from the helper. A handler that
    // returned its own JSON would bypass both.
    mockTrim.mockReturnValue({ content: '{"trimmed":true}', truncated: true })
    const report = await call({ stackName: 'prod' })
    expect(report).toEqual({ trimmed: true })
  })
})
