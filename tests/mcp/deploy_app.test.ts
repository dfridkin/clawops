import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

// ── plan layer ────────────────────────────────────────────────────────────────
const mockGeneratePlan = vi.fn()
vi.mock('../../src/plan/generate.js', () => ({ generatePlan: mockGeneratePlan }))

const mockApplyPlan = vi.fn()
vi.mock('../../src/plan/apply.js', () => ({ applyPlan: mockApplyPlan }))

// ── CLI handlers used as fallback/post-step ───────────────────────────────────
const mockHandleUp = vi.fn()
vi.mock('../../src/mcp/tools/cli/up.js', () => ({ handleUp: mockHandleUp }))

const mockHandleStatus = vi.fn()
vi.mock('../../src/mcp/tools/cli/status.js', () => ({ handleStatus: mockHandleStatus }))

// ── progress ──────────────────────────────────────────────────────────────────
const mockMakeProgressEmitter = vi.fn()
vi.mock('../../src/mcp/progress.js', () => ({
  makeProgressEmitter: mockMakeProgressEmitter,
  startTask: vi.fn(),
  updateTask: vi.fn(),
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
    openclaw: { version: 'latest' },
    network: { allowedSshCidrs: [], allowedGatewayCidrs: [] },
  },
  diff: {
    create: [{ urn: 'u1', type: 'aws:ec2/instance:Instance', name: 'server' }],
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
  mockGeneratePlan.mockResolvedValue(basePlan)
  mockApplyPlan.mockResolvedValue({
    outputs: { gatewayUrl: 'https://gw.example.com', publicIp: '1.2.3.4' },
    changeSummary: { create: 1 },
    durationMs: 2000,
  })
  mockHandleUp.mockResolvedValue({ content: [{ type: 'text', text: 'up done' }] })
  mockHandleStatus.mockResolvedValue({ content: [{ type: 'text', text: 'status ok' }] })
  mockMakeProgressEmitter.mockReturnValue(() => {})
})

describe('handleWorkflowDeployApp()', () => {
  it('delegates to handleUp for local provider', async () => {
    const server = makeServer()
    const { handleWorkflowDeployApp } = await import('../../src/mcp/tools/workflow/deploy_app.js')
    const result = await handleWorkflowDeployApp(
      { provider: 'local', stackName: 'default', instanceType: 'small' },
      server,
    )
    expect(mockHandleUp).toHaveBeenCalledOnce()
    expect(mockGeneratePlan).not.toHaveBeenCalled()
    expect(result.content[0]).toEqual({ type: 'text', text: 'up done' })
  })

  it('calls generatePlan with correct args', async () => {
    const server = makeServer()
    const { handleWorkflowDeployApp } = await import('../../src/mcp/tools/workflow/deploy_app.js')
    await handleWorkflowDeployApp(
      { provider: 'aws', region: 'eu-west-1', stackName: 'prod', instanceType: 'medium' },
      server,
    )
    expect(mockGeneratePlan).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'aws',
        region: 'eu-west-1',
        stackName: 'prod',
        instanceType: 'medium',
      }),
    )
  })

  it('falls back to handleUp when generatePlan throws', async () => {
    mockGeneratePlan.mockRejectedValue(new Error('preview failed'))
    const server = makeServer()
    const { handleWorkflowDeployApp } = await import('../../src/mcp/tools/workflow/deploy_app.js')
    await handleWorkflowDeployApp(
      { provider: 'aws', stackName: 'default', instanceType: 'small' },
      server,
    )
    expect(mockHandleUp).toHaveBeenCalledOnce()
    expect(mockApplyPlan).not.toHaveBeenCalled()
  })

  it('returns cancelled text when elicitation is declined', async () => {
    const server = makeServer({ action: 'decline' })
    const { handleWorkflowDeployApp } = await import('../../src/mcp/tools/workflow/deploy_app.js')
    const result = await handleWorkflowDeployApp(
      { provider: 'aws', stackName: 'default', instanceType: 'small' },
      server,
    )
    expect((result.content[0] as { type: 'text'; text: string }).text).toMatch(/cancelled/)
    expect(mockApplyPlan).not.toHaveBeenCalled()
  })

  it('returns cancelled text when confirmed=false', async () => {
    const server = makeServer({ action: 'accept', content: { confirmed: false } })
    const { handleWorkflowDeployApp } = await import('../../src/mcp/tools/workflow/deploy_app.js')
    const result = await handleWorkflowDeployApp(
      { provider: 'aws', stackName: 'default', instanceType: 'small' },
      server,
    )
    expect((result.content[0] as { type: 'text'; text: string }).text).toMatch(/cancelled/)
  })

  it('calls applyPlan after confirmation', async () => {
    const server = makeServer()
    const { handleWorkflowDeployApp } = await import('../../src/mcp/tools/workflow/deploy_app.js')
    await handleWorkflowDeployApp(
      { provider: 'aws', stackName: 'default', instanceType: 'small' },
      server,
    )
    expect(mockApplyPlan).toHaveBeenCalledOnce()
    expect(mockApplyPlan).toHaveBeenCalledWith(
      expect.objectContaining({ spec: expect.objectContaining({ provider: 'aws' }) }),
      expect.objectContaining({ onOutput: expect.any(Function) }),
    )
  })

  it('returns isError result when applyPlan throws', async () => {
    mockApplyPlan.mockRejectedValue(new Error('pulumi failed'))
    const server = makeServer()
    const { handleWorkflowDeployApp } = await import('../../src/mcp/tools/workflow/deploy_app.js')
    const result = await handleWorkflowDeployApp(
      { provider: 'aws', stackName: 'default', instanceType: 'small' },
      server,
    )
    expect(result.isError).toBe(true)
    expect((result.content[0] as { type: 'text'; text: string }).text).toMatch(/Apply failed/)
  })

  it('calls handleStatus after successful apply', async () => {
    const server = makeServer()
    const { handleWorkflowDeployApp } = await import('../../src/mcp/tools/workflow/deploy_app.js')
    await handleWorkflowDeployApp(
      { provider: 'aws', stackName: 'default', instanceType: 'small' },
      server,
    )
    expect(mockHandleStatus).toHaveBeenCalledOnce()
    expect(mockHandleStatus).toHaveBeenCalledWith(
      expect.objectContaining({ stackName: 'default' }),
      server,
    )
  })

  it('continues gracefully when handleStatus throws', async () => {
    mockHandleStatus.mockRejectedValue(new Error('SSH timeout'))
    const server = makeServer()
    const { handleWorkflowDeployApp } = await import('../../src/mcp/tools/workflow/deploy_app.js')
    const result = await handleWorkflowDeployApp(
      { provider: 'aws', stackName: 'default', instanceType: 'small' },
      server,
    )
    expect(result.isError).toBeFalsy()
    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(text).toMatch(/Status check skipped/)
  })

  it('output contains plan, apply and status section headers', async () => {
    const server = makeServer()
    const { handleWorkflowDeployApp } = await import('../../src/mcp/tools/workflow/deploy_app.js')
    const result = await handleWorkflowDeployApp(
      { provider: 'aws', stackName: 'default', instanceType: 'small' },
      server,
    )
    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(text).toMatch(/Step 1/)
    expect(text).toMatch(/Step 2/)
    expect(text).toMatch(/Step 3/)
  })

  it('elicitation message includes diff counts from plan', async () => {
    const server = makeServer({ action: 'decline' })
    const { handleWorkflowDeployApp } = await import('../../src/mcp/tools/workflow/deploy_app.js')
    await handleWorkflowDeployApp(
      { provider: 'aws', stackName: 'default', instanceType: 'small' },
      server,
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const callArg = (server.server.elicitInput as any).mock.calls[0][0] as { message: string }
    expect(callArg.message).toMatch(/1 to create/)
  })
})
