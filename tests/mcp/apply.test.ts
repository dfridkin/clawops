import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

// ── node:fs ──────────────────────────────────────────────────────────────────
const mockReadFileSync = vi.fn()
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, readFileSync: mockReadFileSync }
})

// ── plan layer ────────────────────────────────────────────────────────────────
const mockValidatePlan = vi.fn()
vi.mock('../../src/plan/validate.js', () => ({ validatePlan: mockValidatePlan }))

const mockApplyPlan = vi.fn()
vi.mock('../../src/plan/apply.js', () => ({ applyPlan: mockApplyPlan }))

// ── MCP helpers ───────────────────────────────────────────────────────────────
const mockTrimForMcp = vi.fn()
vi.mock('../../src/mcp/tools/_trim.js', () => ({ trimForMcp: mockTrimForMcp }))

const mockStartTask = vi.fn()
const mockUpdateTask = vi.fn()
const mockMakeProgressEmitter = vi.fn()
vi.mock('../../src/mcp/progress.js', () => ({
  startTask: mockStartTask,
  updateTask: mockUpdateTask,
  makeProgressEmitter: mockMakeProgressEmitter,
}))

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
    openclaw: { version: 'stable' },
    network: { allowedSshCidrs: [], allowedGatewayCidrs: [] },
  },
  diff: {
    create: [{ urn: 'urn:1', type: 'aws:ec2/instance:Instance', name: 'server' }],
    update: [],
    delete: [],
    totalChanges: 1,
  },
}

type ElicitAction = 'accept' | 'decline' | 'cancel'

function makeServer(
  elicitResult: { action: ElicitAction; content?: Record<string, unknown> } = {
    action: 'accept',
    content: { confirmed: true },
  },
): McpServer {
  return {
    server: {
      elicitInput: vi.fn().mockResolvedValue(elicitResult),
      notification: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as McpServer
}

beforeEach(() => {
  vi.clearAllMocks()
  mockReadFileSync.mockReturnValue(JSON.stringify(basePlan))
  mockValidatePlan.mockReturnValue({ ok: true, errors: [] })
  mockApplyPlan.mockResolvedValue({
    outputs: { gatewayUrl: 'https://gw.example.com', publicIp: '1.2.3.4' },
    changeSummary: { create: 1 },
    durationMs: 1234,
  })
  mockTrimForMcp.mockImplementation((content: string) => ({ content, truncated: false }))
  mockMakeProgressEmitter.mockReturnValue(() => {})
})

describe('handleApply()', () => {
  it('returns errText when readFileSync throws', async () => {
    mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT: no such file') })
    const { handleApply } = await import('../../src/mcp/tools/cli/apply.js')
    const result = await handleApply({ planPath: '/tmp/plan.json', yes: true }, makeServer())
    expect(result.isError).toBe(true)
    expect((result.content[0] as { type: 'text'; text: string }).text).toMatch(/Cannot read/)
  })

  it('returns errText for invalid JSON content', async () => {
    mockReadFileSync.mockReturnValue('not valid json {{{')
    const { handleApply } = await import('../../src/mcp/tools/cli/apply.js')
    const result = await handleApply({ planPath: '/tmp/plan.json', yes: true }, makeServer())
    expect(result.isError).toBe(true)
  })

  it('returns errText when validatePlan fails', async () => {
    mockValidatePlan.mockReturnValue({ ok: false, errors: ['missing required field'] })
    const { handleApply } = await import('../../src/mcp/tools/cli/apply.js')
    const result = await handleApply({ planPath: '/tmp/plan.json', yes: true }, makeServer())
    expect(result.isError).toBe(true)
    expect((result.content[0] as { type: 'text'; text: string }).text).toMatch(/Invalid plan/)
  })

  it('returns errText for local provider', async () => {
    const localPlan = { ...basePlan, spec: { ...basePlan.spec, provider: 'local' } }
    mockReadFileSync.mockReturnValue(JSON.stringify(localPlan))
    const { handleApply } = await import('../../src/mcp/tools/cli/apply.js')
    const result = await handleApply({ planPath: '/tmp/plan.json', yes: true }, makeServer())
    expect(result.isError).toBe(true)
    expect((result.content[0] as { type: 'text'; text: string }).text).toMatch(/local provider/)
  })

  it('returns Apply cancelled when elicitation confirmed=false', async () => {
    const server = makeServer({ action: 'accept', content: { confirmed: false } })
    const { handleApply } = await import('../../src/mcp/tools/cli/apply.js')
    const result = await handleApply({ planPath: '/tmp/plan.json', yes: false }, server)
    expect(result.isError).toBeFalsy()
    expect((result.content[0] as { type: 'text'; text: string }).text).toBe('Apply cancelled.')
  })

  it('returns Apply cancelled when elicitation action is not accept', async () => {
    const server = makeServer({ action: 'decline', content: undefined })
    const { handleApply } = await import('../../src/mcp/tools/cli/apply.js')
    const result = await handleApply({ planPath: '/tmp/plan.json', yes: false }, server)
    expect((result.content[0] as { type: 'text'; text: string }).text).toBe('Apply cancelled.')
  })

  it('skips elicitation when yes=true', async () => {
    const server = makeServer()
    const { handleApply } = await import('../../src/mcp/tools/cli/apply.js')
    await handleApply({ planPath: '/tmp/plan.json', yes: true }, server)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((server.server.elicitInput as any)).not.toHaveBeenCalled()
  })

  it('calls applyPlan with the parsed plan', async () => {
    const { handleApply } = await import('../../src/mcp/tools/cli/apply.js')
    await handleApply({ planPath: '/tmp/plan.json', yes: true }, makeServer())
    expect(mockApplyPlan).toHaveBeenCalledOnce()
    expect(mockApplyPlan).toHaveBeenCalledWith(
      expect.objectContaining({ spec: expect.objectContaining({ provider: 'aws' }) }),
      expect.objectContaining({ onOutput: expect.any(Function) }),
    )
  })

  it('includes gatewayUrl and publicIp in result', async () => {
    const { handleApply } = await import('../../src/mcp/tools/cli/apply.js')
    const result = await handleApply({ planPath: '/tmp/plan.json', yes: true }, makeServer())
    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(text).toMatch(/Gateway URL/)
    expect(text).toMatch(/Public IP/)
  })

  it('includes duration in result', async () => {
    const { handleApply } = await import('../../src/mcp/tools/cli/apply.js')
    const result = await handleApply({ planPath: '/tmp/plan.json', yes: true }, makeServer())
    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(text).toMatch(/Duration/)
  })

  it('calls startTask before apply and updateTask(completed) after', async () => {
    const { handleApply } = await import('../../src/mcp/tools/cli/apply.js')
    await handleApply({ planPath: '/tmp/plan.json', yes: true }, makeServer())
    expect(mockStartTask).toHaveBeenCalledOnce()
    expect(mockUpdateTask).toHaveBeenCalledWith(expect.any(String), 'completed', expect.any(String))
  })

  it('rethrows applyPlan errors and marks task failed', async () => {
    mockApplyPlan.mockRejectedValue(new Error('pulumi exploded'))
    const { handleApply } = await import('../../src/mcp/tools/cli/apply.js')
    await expect(
      handleApply({ planPath: '/tmp/plan.json', yes: true }, makeServer()),
    ).rejects.toThrow('pulumi exploded')
    expect(mockUpdateTask).toHaveBeenCalledWith(
      expect.any(String), 'failed', undefined, 'pulumi exploded',
    )
  })

  it('elicitation message includes diff counts', async () => {
    const server = makeServer({ action: 'decline' })
    const { handleApply } = await import('../../src/mcp/tools/cli/apply.js')
    await handleApply({ planPath: '/tmp/plan.json', yes: false }, server)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const callArg = (server.server.elicitInput as any).mock.calls[0][0] as { message: string }
    expect(callArg.message).toMatch(/1 to create/)
  })
})
