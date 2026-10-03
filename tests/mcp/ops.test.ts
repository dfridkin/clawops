import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { makeFakeContext } from '../helpers/context.js'
import { FakeSshSession } from '../helpers/ssh.js'
import { FAKE_CONN } from '../helpers/context.js'

vi.mock('../../src/cli/context.js', () => ({ buildContext: vi.fn() }))
// `clawops_up` deploys through the same plan and apply as the CLI, rather than writing stack
// config of its own — a third implementation that could not deploy, for want of sshPublicKey.
const { mockGeneratePlan, mockApplyPlan } = vi.hoisted(() => ({
  mockGeneratePlan: vi.fn(),
  mockApplyPlan: vi.fn(),
}))
vi.mock('../../src/plan/generate.js', () => ({ generatePlan: mockGeneratePlan }))
vi.mock('../../src/plan/apply.js', () => ({ applyPlan: mockApplyPlan }))
vi.mock('../../src/providers/firewall.js', () => ({
  detectEgressIp: vi.fn().mockResolvedValue({ ok: true, ip: '203.0.113.4' }),
}))
vi.mock('../../src/transport/pool.js', () => ({ acquireSession: vi.fn(), drainPool: vi.fn() }))
vi.mock('../../src/mcp/tools/_conn.js', () => ({
  resolveConn: vi.fn(),
  okText: vi.fn(t => ({ content: [{ type: 'text', text: t }] })),
  errText: vi.fn(t => ({ content: [{ type: 'text', text: t }], isError: true })),
}))
vi.mock('../../src/mcp/progress.js', () => ({
  startTask: vi.fn(),
  updateTask: vi.fn(),
  makeProgressEmitter: vi.fn(() => () => {}),
}))
vi.mock('../../src/mcp/tools/_trim.js', () => ({
  trimForMcp: vi.fn((s: string) => ({ content: s, truncated: false })),
}))

function makeServer(action: 'accept' | 'decline' = 'accept', confirmed = true): McpServer {
  return {
    server: {
      getClientCapabilities: () => ({ elicitation: {} }),
      elicitInput: vi.fn().mockResolvedValue({ action, content: { confirmed } }),
      notification: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as McpServer
}

function makeCloudContext() {
  const ctx = makeFakeContext()
  const stack = {
    setConfig: vi.fn().mockResolvedValue(undefined),
    up: vi.fn().mockResolvedValue({
      outputs: { publicIp: { value: '1.2.3.4' }, gatewayUrl: { value: 'https://gw' } },
      summary: { resourceChanges: { create: 1 } },
    }),
    preview: vi.fn().mockResolvedValue({ changeSummary: { create: 1 } }),
    destroy: vi.fn().mockResolvedValue(undefined),
  }
  return { ctx, stack }
}

async function getMocks() {
  const { buildContext } = await import('../../src/cli/context.js')
  const { acquireSession } = await import('../../src/transport/pool.js')
  const { resolveConn } = await import('../../src/mcp/tools/_conn.js')
  return {
    buildContext: vi.mocked(buildContext),
    acquireSession: vi.mocked(acquireSession),
    resolveConn: vi.mocked(resolveConn),
  }
}

beforeEach(async () => {
  vi.clearAllMocks()
  const { resolveConn } = await getMocks()
  resolveConn.mockResolvedValue(FAKE_CONN)
  mockGeneratePlan.mockResolvedValue({
    apiVersion: 'clawops.dev/v1',
    kind: 'DeployPlan',
    metadata: { name: 'default', generatedAt: '', generator: 'clawops', generatorVersion: '2.0.0' },
    spec: { provider: 'aws', stackName: 'default', instanceType: 't3.small', openclaw: { version: '2026.9.2' } },
    diff: { create: [], update: [], delete: [], totalChanges: 0 },
  })
  mockApplyPlan.mockResolvedValue({
    outputs: { publicIp: '1.2.3.4', gatewayUrl: 'https://1.2.3.4:18789' },
    changeSummary: { create: 2 },
    durationMs: 1,
  })
})

describe('handleUp', () => {
  it('returns cancelled when elicitation is declined', async () => {
    const { buildContext } = await getMocks()
    const { ctx, stack } = makeCloudContext()
    buildContext.mockReturnValue({ ...ctx, getStack: vi.fn().mockResolvedValue(stack) })

    const { handleUp } = await import('../../src/mcp/tools/cli/up.js')
    const result = await handleUp({ instanceType: 'small', dryRun: false }, makeServer('decline'))
    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(text).toMatch(/cancel/i)
  })

  it('deploys through the shared plan and apply when confirmed', async () => {
    const { buildContext } = await getMocks()
    const { ctx, stack } = makeCloudContext()
    buildContext.mockReturnValue({ ...ctx, getStack: vi.fn().mockResolvedValue(stack) })

    const { handleUp } = await import('../../src/mcp/tools/cli/up.js')
    await handleUp({ instanceType: 'small', dryRun: false }, makeServer())
    expect(mockGeneratePlan).toHaveBeenCalledOnce()
    expect(mockApplyPlan).toHaveBeenCalledOnce()
    // The old implementation wrote three pieces of stack config and called up() itself.
    expect(stack.up).not.toHaveBeenCalled()
  })

  it('carries the network flags into the plan', async () => {
    const { buildContext } = await getMocks()
    const { ctx, stack } = makeCloudContext()
    buildContext.mockReturnValue({ ...ctx, getStack: vi.fn().mockResolvedValue(stack) })

    const { handleUp } = await import('../../src/mcp/tools/cli/up.js')
    await handleUp({ instanceType: 'small', dryRun: false, sshCidr: 'auto' }, makeServer())
    expect(mockGeneratePlan).toHaveBeenCalledWith(
      expect.objectContaining({
        network: expect.objectContaining({ allowedSshCidrs: ['203.0.113.4/32'] }),
      }),
    )
  })

  it('generates a plan and applies nothing when dryRun=true', async () => {
    const { buildContext } = await getMocks()
    const { ctx, stack } = makeCloudContext()
    buildContext.mockReturnValue({ ...ctx, getStack: vi.fn().mockResolvedValue(stack) })

    const { handleUp } = await import('../../src/mcp/tools/cli/up.js')
    await handleUp({ instanceType: 'small', dryRun: true }, makeServer())
    expect(mockGeneratePlan).toHaveBeenCalledOnce()
    expect(mockApplyPlan).not.toHaveBeenCalled()
    expect(stack.up).not.toHaveBeenCalled()
  })

  it('skips elicitation when dryRun=true', async () => {
    const { buildContext } = await getMocks()
    const { ctx, stack } = makeCloudContext()
    buildContext.mockReturnValue({ ...ctx, getStack: vi.fn().mockResolvedValue(stack) })

    const server = makeServer()
    const { handleUp } = await import('../../src/mcp/tools/cli/up.js')
    await handleUp({ instanceType: 'small', dryRun: true }, server)
    expect(server.server.elicitInput).not.toHaveBeenCalled()
  })
})

describe('handleDestroy', () => {
  it('returns cancelled when elicitation is declined', async () => {
    const { buildContext } = await getMocks()
    const { ctx, stack } = makeCloudContext()
    buildContext.mockReturnValue({ ...ctx, getStack: vi.fn().mockResolvedValue(stack) })

    const { handleDestroy } = await import('../../src/mcp/tools/cli/destroy.js')
    const result = await handleDestroy({ stackName: 'default', yes: false }, makeServer('decline'))
    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(text).toMatch(/cancel/i)
    expect(stack.destroy).not.toHaveBeenCalled()
  })

  it('calls stack.destroy() when accepted', async () => {
    const { buildContext } = await getMocks()
    const { ctx, stack } = makeCloudContext()
    buildContext.mockReturnValue({ ...ctx, getStack: vi.fn().mockResolvedValue(stack) })

    const { handleDestroy } = await import('../../src/mcp/tools/cli/destroy.js')
    await handleDestroy({ stackName: 'default', yes: false }, makeServer())
    expect(stack.destroy).toHaveBeenCalledOnce()
  })

  it('skips elicitation when yes=true', async () => {
    const { buildContext } = await getMocks()
    const { ctx, stack } = makeCloudContext()
    buildContext.mockReturnValue({ ...ctx, getStack: vi.fn().mockResolvedValue(stack) })

    const server = makeServer()
    const { handleDestroy } = await import('../../src/mcp/tools/cli/destroy.js')
    await handleDestroy({ stackName: 'default', yes: true }, server)
    expect(server.server.elicitInput).not.toHaveBeenCalled()
    expect(stack.destroy).toHaveBeenCalledOnce()
  })

  it('returns errText for local provider', async () => {
    const { buildContext } = await getMocks()
    buildContext.mockReturnValue(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { ...makeFakeContext(), adapter: { name: 'local' } } as any,
    )

    const { handleDestroy } = await import('../../src/mcp/tools/cli/destroy.js')
    const result = await handleDestroy({ stackName: 'default', yes: true }, makeServer())
    expect(result.isError).toBe(true)
  })
})

describe('handleGatewayRestart', () => {
  it('returns cancelled when declined', async () => {
    const { handleGatewayRestart } = await import('../../src/mcp/tools/cli/gateway.js')
    const result = await handleGatewayRestart({ stackName: 'default' }, makeServer('decline'))
    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(text).toMatch(/cancel/i)
  })

  /** A Linux host running 2026.9.2, published on `hostIp`, whose restart succeeds unless told otherwise. */
  function restartHost(hostIp: string, run: { stderr?: string; code?: number } = {}) {
    return new FakeSshSession()
      .respond(/uname/, { stdout: 'Linux\n' })
      .respond(/\.Config\.Image/, { stdout: 'ghcr.io/openclaw/openclaw:2026.9.2\n' })
      .respond(/PortBindings/, { stdout: JSON.stringify({ '18789/tcp': [{ HostIp: hostIp, HostPort: '18789' }] }) })
      .respond(/docker run/, { stdout: '', stderr: run.stderr ?? '', code: run.code ?? 0 })
      .respond(/startupz/, { stdout: '{"ok":true,"status":"started"}' })
  }

  it('restarts on the version the host already runs, and says so', async () => {
    const { buildContext, acquireSession } = await getMocks()
    buildContext.mockReturnValue(makeFakeContext())
    const session = restartHost('127.0.0.1')
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const { handleGatewayRestart } = await import('../../src/mcp/tools/cli/gateway.js')
    const result = await handleGatewayRestart({ stackName: 'default' }, makeServer())
    expect(result.isError).toBeFalsy()
    const run = session.execCalls().find((c) => c.includes('docker run'))!
    expect(run).toContain('ghcr.io/openclaw/openclaw:2026.9.2')
  })

  it('keeps a gateway published on every interface on every interface', async () => {
    // The handler used to rebuild the run command itself with the default scope, so an agent
    // restarting a --publish-gateway all deployment took it off the public interface.
    const { buildContext, acquireSession } = await getMocks()
    buildContext.mockReturnValue(makeFakeContext())
    const session = restartHost('0.0.0.0')
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const { handleGatewayRestart } = await import('../../src/mcp/tools/cli/gateway.js')
    await handleGatewayRestart({ stackName: 'default' }, makeServer())
    const run = session.execCalls().find((c) => c.includes('docker run'))!
    expect(run).not.toContain('127.0.0.1:18789')
    expect(run).toMatch(/-p\s+(0\.0\.0\.0:)?18789:18789/)
  })

  it('keeps a loopback gateway on loopback', async () => {
    const { buildContext, acquireSession } = await getMocks()
    buildContext.mockReturnValue(makeFakeContext())
    const session = restartHost('127.0.0.1')
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const { handleGatewayRestart } = await import('../../src/mcp/tools/cli/gateway.js')
    await handleGatewayRestart({ stackName: 'default' }, makeServer())
    const run = session.execCalls().find((c) => c.includes('docker run'))!
    expect(run).toContain('127.0.0.1:18789')
  })

  it('returns errText when restart command fails', async () => {
    const { buildContext, acquireSession } = await getMocks()
    buildContext.mockReturnValue(makeFakeContext())
    const session = restartHost('127.0.0.1', { stderr: 'docker: error', code: 1 })
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const { handleGatewayRestart } = await import('../../src/mcp/tools/cli/gateway.js')
    const result = await handleGatewayRestart({ stackName: 'default' }, makeServer())
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('docker: error')
  })
})
