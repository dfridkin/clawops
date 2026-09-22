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

// ── the network layer plan gained: egress detection and the tailnet probe ─────
const mockDetectEgressIp = vi.fn()
vi.mock('../../src/providers/firewall.js', () => ({ detectEgressIp: mockDetectEgressIp }))
const mockProbeSsh = vi.fn()
vi.mock('../../src/harden/tailscale-cutover.js', () => ({ probeSsh: mockProbeSsh }))

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
  mockDetectEgressIp.mockResolvedValue({ ok: true, ip: '203.0.113.4' })
  mockProbeSsh.mockResolvedValue(true)
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

describe('the flags that decide who can reach the deployment', () => {
  const TAILNET = { ip: '100.96.109.52', verifiedAt: '2026-09-22T00:00:00.000Z' }

  function ctx(tailscale?: typeof TAILNET) {
    mockBuildContext.mockReturnValue({
      config: {
        ssh: { keyPath: '/k', knownHostsPath: '/kh' },
        stacks: { default: { provider: 'aws', ...(tailscale ? { tailscale } : {}) } },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      adapter: {
        name: 'aws',
        getConnectionInfo: () => ({ host: TAILNET.ip, port: 22, user: 'ubuntu', privateKeyPath: '/k', knownHostsPath: '/kh' }),
      },
      stackName: 'default',
      getStack: vi.fn().mockResolvedValue({
        outputs: async () => ({
          instanceId: { value: 'i-0abc' }, publicIp: { value: '34.200.67.239' }, gatewayUrl: { value: 'http://gw' },
          region: { value: 'us-east-1' }, provisionedAt: { value: '2026-09-22T00:00:00.000Z' },
          sshHost: { value: '34.200.67.239' }, sshPort: { value: 22 }, sshUser: { value: 'ubuntu' },
        }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    })
  }

  // Without these an agent could only ever plan a host nothing can connect to.
  it('passes the SSH rule through to the plan', async () => {
    const { handlePlan } = await import('../../src/mcp/tools/cli/plan.js')
    await handlePlan({ stackName: 'default', sshCidr: '203.0.113.4/32' }, noopServer)
    expect(mockGeneratePlan).toHaveBeenCalledWith(
      expect.objectContaining({ network: expect.objectContaining({ allowedSshCidrs: ['203.0.113.4/32'] }) }),
    )
  })

  it("resolves 'auto' to this machine, at plan time", async () => {
    const { handlePlan } = await import('../../src/mcp/tools/cli/plan.js')
    await handlePlan({ stackName: 'default', sshCidr: 'auto' }, noopServer)
    expect(mockGeneratePlan).toHaveBeenCalledWith(
      expect.objectContaining({ network: expect.objectContaining({ allowedSshCidrs: ['203.0.113.4/32'] }) }),
    )
  })

  it('carries the gateway publish choice and the OpenClaw version', async () => {
    const { handlePlan } = await import('../../src/mcp/tools/cli/plan.js')
    await handlePlan({ stackName: 'default', publishGateway: 'all', gatewayCidr: '203.0.113.4/32', openclawVersion: '2026.9.2' }, noopServer)
    expect(mockGeneratePlan).toHaveBeenCalledWith(
      expect.objectContaining({
        openclawVersion: '2026.9.2',
        network: expect.objectContaining({ publishGateway: 'all', allowedGatewayCidrs: ['203.0.113.4/32'] }),
      }),
    )
  })

  it('refuses a bad CIDR rather than planning a rule nobody meant', async () => {
    const { handlePlan } = await import('../../src/mcp/tools/cli/plan.js')
    const r = await handlePlan({ stackName: 'default', sshCidr: '203.0.113.4' }, noopServer)
    expect(r.isError).toBe(true)
    expect(mockGeneratePlan).not.toHaveBeenCalled()
  })

  describe('privateOnly', () => {
    it('plans no public ingress, and names the tailnet address that remains', async () => {
      ctx(TAILNET)
      const { handlePlan } = await import('../../src/mcp/tools/cli/plan.js')
      await handlePlan({ stackName: 'default', privateOnly: true }, noopServer)
      expect(mockGeneratePlan).toHaveBeenCalledWith(
        expect.objectContaining({
          network: { allowedSshCidrs: [], allowedGatewayCidrs: [], tailscale: { enabled: true, privateOnly: true, ip: TAILNET.ip } },
        }),
      )
    })

    it('refuses when this machine cannot reach the tailnet address', async () => {
      ctx(TAILNET)
      mockProbeSsh.mockResolvedValue(false)
      const { handlePlan } = await import('../../src/mcp/tools/cli/plan.js')
      const r = await handlePlan({ stackName: 'default', privateOnly: true }, noopServer)
      expect(r.isError).toBe(true)
      expect(mockGeneratePlan).not.toHaveBeenCalled()
    })

    it('refuses on a stack that was never moved onto a tailnet', async () => {
      ctx()
      const { handlePlan } = await import('../../src/mcp/tools/cli/plan.js')
      const r = await handlePlan({ stackName: 'default', privateOnly: true }, noopServer)
      expect(r.isError).toBe(true)
      expect(String((r.content?.[0] as { text?: unknown } | undefined)?.text)).toMatch(/tailnet/)
      expect(mockGeneratePlan).not.toHaveBeenCalled()
    })
  })
})
