import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

// ── node:fs ──────────────────────────────────────────────────────────────────
const mockWriteFileSync = vi.fn()
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, writeFileSync: mockWriteFileSync }
})

// ── context ───────────────────────────────────────────────────────────────────
const mockBuildContext = vi.fn()
vi.mock('../../src/cli/context.js', () => ({ buildContext: mockBuildContext }))

// ── plan layer ────────────────────────────────────────────────────────────────
const mockGeneratePlan = vi.fn()
vi.mock('../../src/plan/generate.js', () => ({ generatePlan: mockGeneratePlan }))

// ── MCP helpers ───────────────────────────────────────────────────────────────
const mockTrimForMcp = vi.fn()
vi.mock('../../src/mcp/tools/_trim.js', () => ({ trimForMcp: mockTrimForMcp }))

// ── test fixtures ─────────────────────────────────────────────────────────────
const basePlan = {
  apiVersion: 'clawops.dev/v1' as const,
  kind: 'DeployPlan' as const,
  metadata: {
    name: 'default',
    generatedAt: new Date().toISOString(),
    generator: 'clawops',
    generatorVersion: '0.2.0',
  },
  spec: {
    provider: 'aws' as const,
    region: 'us-east-1',
    stackName: 'default',
    instanceType: 'small',
    openclaw: { version: 'latest' },
    network: { allowedSshCidrs: [], allowedGatewayCidrs: [] },
  },
}

const noopServer = {} as unknown as McpServer

beforeEach(() => {
  vi.clearAllMocks()
  mockBuildContext.mockReturnValue({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    config: {} as any,
    adapter: { name: 'aws' },
    stackName: 'default',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getStack: vi.fn() as any,
  })
  mockGeneratePlan.mockResolvedValue(basePlan)
  mockTrimForMcp.mockImplementation((content: string) => ({ content, truncated: false }))
})

describe('handlePlan()', () => {
  it('returns errText for local adapter', async () => {
    mockBuildContext.mockReturnValue({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      config: {} as any,
      adapter: { name: 'local' },
      stackName: 'default',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getStack: vi.fn() as any,
    })
    const { handlePlan } = await import('../../src/mcp/tools/cli/plan.js')
    const result = await handlePlan({ stackName: 'default' }, noopServer)
    expect(result.isError).toBe(true)
    expect((result.content[0] as { type: 'text'; text: string }).text).toMatch(/local provider/)
  })

  it('returns errText when generatePlan throws', async () => {
    mockGeneratePlan.mockRejectedValue(new Error('preview failed'))
    const { handlePlan } = await import('../../src/mcp/tools/cli/plan.js')
    const result = await handlePlan({ stackName: 'default', provider: 'aws' }, noopServer)
    expect(result.isError).toBe(true)
    expect((result.content[0] as { type: 'text'; text: string }).text).toMatch(/Plan generation failed/)
  })

  it('calls generatePlan with correct args', async () => {
    const { handlePlan } = await import('../../src/mcp/tools/cli/plan.js')
    await handlePlan(
      { stackName: 'prod', provider: 'gcp', region: 'us-central1', instanceType: 'medium' },
      noopServer,
    )
    expect(mockGeneratePlan).toHaveBeenCalledWith(
      expect.objectContaining({
        stackName: 'default', // from ctx.stackName, not input
        provider: 'gcp',
        region: 'us-central1',
        instanceType: 'medium',
      }),
    )
  })

  it('returns plan JSON inline when no outPath', async () => {
    const { handlePlan } = await import('../../src/mcp/tools/cli/plan.js')
    const result = await handlePlan({ stackName: 'default' }, noopServer)
    expect(result.isError).toBeFalsy()
    const text = (result.content[0] as { type: 'text'; text: string }).text
    const parsed = JSON.parse(text)
    expect(parsed.apiVersion).toBe('clawops.dev/v1')
  })

  it('writes plan to file when outPath is provided', async () => {
    const { handlePlan } = await import('../../src/mcp/tools/cli/plan.js')
    const result = await handlePlan({ stackName: 'default', outPath: '/tmp/plan.json' }, noopServer)
    expect(mockWriteFileSync).toHaveBeenCalledOnce()
    expect(mockWriteFileSync).toHaveBeenCalledWith('/tmp/plan.json', expect.stringContaining('clawops.dev/v1'), 'utf-8')
    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(text).toMatch(/Plan written to/)
  })

  it('returns errText when writeFileSync throws', async () => {
    mockWriteFileSync.mockImplementation(() => { throw new Error('EACCES: permission denied') })
    const { handlePlan } = await import('../../src/mcp/tools/cli/plan.js')
    const result = await handlePlan({ outPath: '/root/plan.json' }, noopServer)
    expect(result.isError).toBe(true)
    expect((result.content[0] as { type: 'text'; text: string }).text).toMatch(/Failed to write/)
  })

  it('returns truncated content when trimForMcp truncates', async () => {
    const truncatedContent = 'x'.repeat(100) + '\n\n[Output truncated'
    mockTrimForMcp.mockReturnValue({ content: truncatedContent, truncated: true })
    const { handlePlan } = await import('../../src/mcp/tools/cli/plan.js')
    const result = await handlePlan({ stackName: 'default' }, noopServer)
    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(text).toBe(truncatedContent)
  })

  it('returns full content when trimForMcp does not truncate', async () => {
    mockTrimForMcp.mockReturnValue({ content: 'small', truncated: false })
    const { handlePlan } = await import('../../src/mcp/tools/cli/plan.js')
    const result = await handlePlan({ stackName: 'default' }, noopServer)
    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(text).toContain('"apiVersion"')
  })
})
