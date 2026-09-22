// clawops_harden: the hardening surface an agent drives, including the Tailscale flows.
//
// The refusals matter more than the successes here. A safeguard the CLI enforces and the MCP
// server does not is not a safeguard — it is a detour.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { HardenInput } from '../../src/mcp/tools/_generated.js'

const h = vi.hoisted(() => ({
  buildContext: vi.fn(),
  getConfig: vi.fn(),
  revertTailnet: vi.fn(),
  cutOverToTailnet: vi.fn(),
  connectionFor: vi.fn(),
  runHardening: vi.fn(),
  resolveModules: vi.fn(),
  makeTailscaleModule: vi.fn(),
  formatHardenSummary: vi.fn(),
}))
vi.mock('../../src/cli/context.js', () => ({ buildContext: h.buildContext }))
vi.mock('../../src/config/store.js', () => ({ getConfig: h.getConfig }))
vi.mock('../../src/harden/flows.js', () => ({
  revertTailnet: h.revertTailnet,
  cutOverToTailnet: h.cutOverToTailnet,
  connectionFor: h.connectionFor,
}))
vi.mock('../../src/harden/index.js', () => ({
  MODULE_CATALOG: [],
  resolveModules: h.resolveModules,
  runHardening: h.runHardening,
  formatHardenSummary: h.formatHardenSummary,
  makeTailscaleModule: h.makeTailscaleModule,
}))

const CONN = { host: '34.200.67.239', port: 22, user: 'ubuntu', privateKeyPath: '/k', knownHostsPath: '/kh' }
const MODULE = { id: 'ssh', label: 'SSH hardening', defaultOn: true }

/** An elicitation-capable server. `accept` is what a user clicking "yes" produces. */
function serverThat(action: 'accept' | 'decline', confirmed = true): McpServer {
  return {
    server: { elicitInput: vi.fn().mockResolvedValue({ action, content: { confirmed } }) },
  } as unknown as McpServer
}

function text(r: { content?: unknown[] }): string {
  return String((r.content?.[0] as { text?: unknown } | undefined)?.text ?? '')
}

/** The schema defaults every boolean, so the generated input type requires them all. */
function input(partial: Partial<HardenInput> = {}): HardenInput {
  return { tailscale: false, tailscaleRevert: false, dryRun: false, yes: false, ...partial }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.getConfig.mockReturnValue({
    version: 1,
    defaults: { stack: 'prod', provider: 'aws' },
    stacks: { prod: { provider: 'aws', stateUrl: 's3://b' } },
    ssh: { keyPath: '/k', knownHostsPath: '/kh' },
  })
  h.buildContext.mockReturnValue({ stackName: 'prod', adapter: { name: 'aws' }, getStack: vi.fn() })
  h.connectionFor.mockResolvedValue(CONN)
  h.resolveModules.mockReturnValue([MODULE])
  h.makeTailscaleModule.mockReturnValue({ id: 'tailscale', label: 'Tailscale membership' })
  h.runHardening.mockResolvedValue([{ module: MODULE, checkResult: { status: 'applied' }, applyResult: { changed: true }, durationMs: 1 }])
  h.formatHardenSummary.mockReturnValue('1 module applied')
  h.cutOverToTailnet.mockResolvedValue({ ok: true, ip: '100.96.109.52', pinned: 3, message: 'clawops now reaches "prod" at 100.96.109.52' })
  h.revertTailnet.mockResolvedValue({ ok: true, publicHost: CONN.host, tailnetIp: '100.96.109.52', message: 'left the tailnet' })
})

describe('clawops_harden', () => {
  it('applies the modules and reports the summary', async () => {
    const { handleHarden } = await import('../../src/mcp/tools/cli/harden.js')
    const r = await handleHarden(input({ stackName: 'prod', yes: true }), serverThat('accept'))
    expect(h.runHardening).toHaveBeenCalledWith(CONN, expect.objectContaining({ modules: [MODULE] }))
    expect(text(r)).toContain('1 module applied')
  })

  it('confirms before changing a live host (R19)', async () => {
    const server = serverThat('decline')
    const { handleHarden } = await import('../../src/mcp/tools/cli/harden.js')
    const r = await handleHarden(input({ stackName: 'prod' }), server)
    expect(text(r)).toContain('Nothing was changed')
    expect(h.runHardening).not.toHaveBeenCalled()
  })

  it('asks nothing for a dry run, which changes nothing', async () => {
    const server = serverThat('decline')
    const { handleHarden } = await import('../../src/mcp/tools/cli/harden.js')
    await handleHarden(input({ stackName: 'prod', dryRun: true }), server)
    expect(server.server.elicitInput).not.toHaveBeenCalled()
    expect(h.runHardening).toHaveBeenCalledWith(CONN, expect.objectContaining({ dryRun: true }))
  })

  it('reports a module failure as an error, not a success', async () => {
    h.runHardening.mockResolvedValue([{ module: MODULE, checkResult: { status: 'failed' }, error: 'sshd refused to reload', durationMs: 1 }])
    const { handleHarden } = await import('../../src/mcp/tools/cli/harden.js')
    const r = await handleHarden(input({ stackName: 'prod', yes: true }), serverThat('accept'))
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('sshd refused to reload')
  })

  describe('the tailnet flows', () => {
    it('joins, then moves clawops onto the address it proved', async () => {
      const { handleHarden } = await import('../../src/mcp/tools/cli/harden.js')
      const r = await handleHarden(input({ stackName: 'prod', tailscale: true, yes: true }), serverThat('accept'))
      expect(h.cutOverToTailnet).toHaveBeenCalledOnce()
      expect(text(r)).toContain('100.96.109.52')
      // The tool must not imply it closed anything: closing is a plan away.
      expect(text(r)).toContain('privateOnly')
    })

    it('keeps the public address when the tailnet cannot be reached', async () => {
      h.cutOverToTailnet.mockResolvedValue({ ok: false, reason: 'this machine is not on the same tailnet' })
      const { handleHarden } = await import('../../src/mcp/tools/cli/harden.js')
      const r = await handleHarden(input({ stackName: 'prod', tailscale: true, yes: true }), serverThat('accept'))
      expect(r.isError).toBe(true)
      expect(text(r)).toContain('still uses its public address')
    })

    it('does not cut over when a module failed', async () => {
      h.runHardening.mockResolvedValue([{ module: MODULE, checkResult: { status: 'failed' }, error: 'join failed', durationMs: 1 }])
      const { handleHarden } = await import('../../src/mcp/tools/cli/harden.js')
      await handleHarden(input({ stackName: 'prod', tailscale: true, yes: true }), serverThat('accept'))
      expect(h.cutOverToTailnet).not.toHaveBeenCalled()
    })

    it('does not cut over on a dry run', async () => {
      const { handleHarden } = await import('../../src/mcp/tools/cli/harden.js')
      await handleHarden(input({ stackName: 'prod', tailscale: true, dryRun: true }), serverThat('accept'))
      expect(h.cutOverToTailnet).not.toHaveBeenCalled()
    })

    it('reverts without touching a module', async () => {
      const { handleHarden } = await import('../../src/mcp/tools/cli/harden.js')
      const r = await handleHarden(input({ stackName: 'prod', tailscaleRevert: true, yes: true }), serverThat('accept'))
      expect(h.revertTailnet).toHaveBeenCalledOnce()
      expect(h.runHardening).not.toHaveBeenCalled()
      expect(text(r)).toContain('left the tailnet')
    })

    /* The refusal an operator gets at the CLI. An agent that could route around it would be
       closing the door and throwing away the key. */
    it('relays the private-only refusal, with the commands that reopen SSH', async () => {
      h.revertTailnet.mockResolvedValue({
        ok: false,
        needsReopen: true,
        reason: '"prod" is private-only: its public ports are closed…\n  clawops plan --stack prod --ssh-cidr auto --out <abs-path>/plan.json',
      })
      const { handleHarden } = await import('../../src/mcp/tools/cli/harden.js')
      const r = await handleHarden(input({ stackName: 'prod', tailscaleRevert: true, yes: true }), serverThat('accept'))
      expect(r.isError).toBe(true)
      expect(text(r)).toContain('clawops plan --stack prod --ssh-cidr auto')
    })

    it('refuses to join and leave in the same call', async () => {
      const { handleHarden } = await import('../../src/mcp/tools/cli/harden.js')
      const r = await handleHarden(input({ stackName: 'prod', tailscale: true, tailscaleRevert: true, yes: true }), serverThat('accept'))
      expect(r.isError).toBe(true)
      expect(h.runHardening).not.toHaveBeenCalled()
      expect(h.revertTailnet).not.toHaveBeenCalled()
    })
  })

  it('says so when the stack has no deployment to harden', async () => {
    h.connectionFor.mockRejectedValue(new Error('no outputs'))
    const { handleHarden } = await import('../../src/mcp/tools/cli/harden.js')
    const r = await handleHarden(input({ stackName: 'prod', yes: true }), serverThat('accept'))
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('no deployment')
  })
})
