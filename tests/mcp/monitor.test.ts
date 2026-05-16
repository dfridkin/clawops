// Unit tests for the clawops_monitor MCP tool.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { makeFakeContext, makeLocalFakeContext, FAKE_LOCAL_STATE } from '../helpers/context.js'
import { FakeSshSession } from '../helpers/ssh.js'

vi.mock('../../src/cli/context.js', () => ({ buildContext: vi.fn() }))
vi.mock('../../src/transport/pool.js', () => ({
  acquireSession: vi.fn(),
  drainPool: vi.fn(),
}))

const FAKE_SERVER = {} as McpServer

beforeEach(() => {
  vi.resetModules()
})

function makeSession(overrides: Partial<{
  inspect: string; stats: string; health: string; config: string; disk: string; logs: string
}> = {}): FakeSshSession {
  const session = new FakeSshSession()
  session
    .onExec(() => ({ stdout: overrides.inspect ?? 'running|ghcr.io/openclaw/openclaw:stable|2026-01-01T00:00:00Z|0', stderr: '', code: 0 }))
    .onExec(() => ({ stdout: overrides.stats   ?? '45.2MiB / 1.9GiB|0.30%', stderr: '', code: 0 }))
    .onExec(() => ({ stdout: overrides.health  ?? 'ok',                       stderr: '', code: 0 }))
    .onExec(() => ({ stdout: overrides.config  ?? JSON.stringify({ meta: { lastTouchedVersion: '2026.4' }, gateway: { auth: { mode: 'token' } } }), stderr: '', code: 0 }))
    .onExec(() => ({ stdout: overrides.disk    ?? '25% used (5G of 20G)',     stderr: '', code: 0 }))
    .onExec(() => ({ stdout: overrides.logs    ?? 'log line 1\nlog line 2',   stderr: '', code: 0 }))
  return session
}

async function getMocks() {
  const { buildContext } = await import('../../src/cli/context.js')
  const { acquireSession, drainPool } = await import('../../src/transport/pool.js')
  return { buildContext: vi.mocked(buildContext), acquireSession: vi.mocked(acquireSession), drainPool: vi.mocked(drainPool) }
}

describe('handleMonitor — cloud stack', () => {
  it('returns gateway reachable=true and version when healthy', async () => {
    const { buildContext, acquireSession } = await getMocks()
    buildContext.mockReturnValue(makeFakeContext())
    acquireSession.mockResolvedValue({ session: makeSession(), release: vi.fn() })

    const { handleMonitor } = await import('../../src/mcp/tools/cli/monitor.js')
    const result = await handleMonitor({ stackName: 'default', tailLines: 5 }, FAKE_SERVER)

    const parsed = JSON.parse((result.content[0] as { text: string }).text)
    expect(parsed.gateway.reachable).toBe(true)
    expect(parsed.gateway.version).toBe('2026.4')
    expect(parsed.gateway.authMode).toBe('token')
  })

  it('returns gateway reachable=false when health endpoint fails', async () => {
    const { buildContext, acquireSession } = await getMocks()
    buildContext.mockReturnValue(makeFakeContext())
    acquireSession.mockResolvedValue({ session: makeSession({ health: 'unreachable' }), release: vi.fn() })

    const { handleMonitor } = await import('../../src/mcp/tools/cli/monitor.js')
    const result = await handleMonitor({ stackName: 'default', tailLines: 5 }, FAKE_SERVER)

    const parsed = JSON.parse((result.content[0] as { text: string }).text)
    expect(parsed.gateway.reachable).toBe(false)
  })

  it('returns container status and resource usage', async () => {
    const { buildContext, acquireSession } = await getMocks()
    buildContext.mockReturnValue(makeFakeContext())
    acquireSession.mockResolvedValue({ session: makeSession(), release: vi.fn() })

    const { handleMonitor } = await import('../../src/mcp/tools/cli/monitor.js')
    const result = await handleMonitor({ stackName: 'default', tailLines: 5 }, FAKE_SERVER)

    const parsed = JSON.parse((result.content[0] as { text: string }).text)
    expect(parsed.container.status).toBe('running')
    expect(parsed.container.memUsage).toBe('45.2MiB / 1.9GiB')
    expect(parsed.container.cpuPct).toBe('0.30%')
    expect(parsed.container.restartCount).toBe(0)
  })

  it('returns disk usage string', async () => {
    const { buildContext, acquireSession } = await getMocks()
    buildContext.mockReturnValue(makeFakeContext())
    acquireSession.mockResolvedValue({ session: makeSession(), release: vi.fn() })

    const { handleMonitor } = await import('../../src/mcp/tools/cli/monitor.js')
    const result = await handleMonitor({ stackName: 'default', tailLines: 5 }, FAKE_SERVER)

    const parsed = JSON.parse((result.content[0] as { text: string }).text)
    expect(parsed.disk).toBe('25% used (5G of 20G)')
  })

  it('includes log lines in response', async () => {
    const { buildContext, acquireSession } = await getMocks()
    buildContext.mockReturnValue(makeFakeContext())
    acquireSession.mockResolvedValue({ session: makeSession(), release: vi.fn() })

    const { handleMonitor } = await import('../../src/mcp/tools/cli/monitor.js')
    const result = await handleMonitor({ stackName: 'default', tailLines: 5 }, FAKE_SERVER)

    const parsed = JSON.parse((result.content[0] as { text: string }).text)
    expect(parsed.logLines).toContain('log line 1')
    expect(parsed.logLines).toContain('log line 2')
  })

  it('includes a capturedAt ISO timestamp', async () => {
    const { buildContext, acquireSession } = await getMocks()
    buildContext.mockReturnValue(makeFakeContext())
    acquireSession.mockResolvedValue({ session: makeSession(), release: vi.fn() })

    const { handleMonitor } = await import('../../src/mcp/tools/cli/monitor.js')
    const result = await handleMonitor({ stackName: 'default', tailLines: 5 }, FAKE_SERVER)

    const parsed = JSON.parse((result.content[0] as { text: string }).text)
    expect(parsed.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('returns not-deployed error when stack has no publicIp', async () => {
    const { buildContext, acquireSession } = await getMocks()
    buildContext.mockReturnValue({
      ...makeFakeContext(),
      getStack: vi.fn().mockResolvedValue({ outputs: vi.fn().mockResolvedValue({}) }),
    } as ReturnType<typeof makeFakeContext>)
    acquireSession.mockResolvedValue({ session: makeSession(), release: vi.fn() })

    const { handleMonitor } = await import('../../src/mcp/tools/cli/monitor.js')
    const result = await handleMonitor({ stackName: 'default', tailLines: 5 }, FAKE_SERVER)

    const parsed = JSON.parse((result.content[0] as { text: string }).text)
    expect(parsed.error).toContain('clawops up')
  })
})

describe('handleMonitor — local stack', () => {
  it('works for local provider using localState connection info', async () => {
    const { buildContext, acquireSession } = await getMocks()
    buildContext.mockReturnValue(makeLocalFakeContext(FAKE_LOCAL_STATE))
    acquireSession.mockResolvedValue({ session: makeSession(), release: vi.fn() })

    const { handleMonitor } = await import('../../src/mcp/tools/cli/monitor.js')
    const result = await handleMonitor({ stackName: 'local-default', tailLines: 5 }, FAKE_SERVER)

    const parsed = JSON.parse((result.content[0] as { text: string }).text)
    expect(parsed.gateway).toBeDefined()
    expect(parsed.container).toBeDefined()
  })

  it('returns error when local stack is not bootstrapped', async () => {
    const { buildContext } = await getMocks()
    buildContext.mockReturnValue(makeLocalFakeContext(null))

    const { handleMonitor } = await import('../../src/mcp/tools/cli/monitor.js')
    const result = await handleMonitor({ stackName: 'local-default', tailLines: 5 }, FAKE_SERVER)

    const parsed = JSON.parse((result.content[0] as { text: string }).text)
    expect(parsed.error).toContain('bootstrapped')
  })
})
