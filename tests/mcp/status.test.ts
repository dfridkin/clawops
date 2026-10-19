import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { makeFakeContext, makeLocalFakeContext, FAKE_LOCAL_STATE } from '../helpers/context.js'
import { MINIMAL_CONFIG } from '../helpers/config.js'

vi.mock('../../src/cli/context.js', () => ({ buildContext: vi.fn() }))
vi.mock('../../src/config/store.js', () => ({ getConfig: vi.fn() }))

// Requests from the stack's host agent are read over SSH; faked so no test dials a host.
const h = vi.hoisted(() => ({ pendingOnHost: vi.fn() }))
vi.mock('../../src/hostagent/operator.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/hostagent/operator.js')>()),
  pendingOnHost: h.pendingOnHost,
}))

const FAKE_SERVER = {} as McpServer

async function getMocks() {
  const { buildContext } = await import('../../src/cli/context.js')
  const { getConfig } = await import('../../src/config/store.js')
  return { buildContext: vi.mocked(buildContext), getConfig: vi.mocked(getConfig) }
}

beforeEach(async () => {
  vi.clearAllMocks()
  h.pendingOnHost.mockResolvedValue({ ok: true, value: [] })
})

describe('handleStatus — cloud path', () => {
  it('returns publicIp and gatewayUrl when stack is deployed', async () => {
    const { buildContext } = await getMocks()
    buildContext.mockReturnValue(makeFakeContext())

    const { handleStatus } = await import('../../src/mcp/tools/cli/status.js')
    const result = await handleStatus({ stackName: 'default' }, FAKE_SERVER)

    const text = (result.content[0] as { type: 'text'; text: string }).text
    const parsed = JSON.parse(text)
    expect(parsed.publicIp).toBe('1.2.3.4')
    expect(parsed.gatewayUrl).toBeDefined()
  })

  it('returns not-deployed status when publicIp is absent', async () => {
    const { buildContext } = await getMocks()
    const ctx = {
      ...makeFakeContext(),
      adapter: { name: 'gcp', getConnectionInfo: vi.fn() },
      getStack: vi.fn().mockResolvedValue({
        outputs: vi.fn().mockResolvedValue({}),
      }),
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    buildContext.mockReturnValue(ctx as any)

    const { handleStatus } = await import('../../src/mcp/tools/cli/status.js')
    const result = await handleStatus({ stackName: 'default' }, FAKE_SERVER)

    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(JSON.parse(text).status).toBe('not deployed')
  })
})

describe('handleStatus — local path', () => {
  it('returns localState when provider is local and state exists', async () => {
    const { buildContext } = await getMocks()
    buildContext.mockReturnValue(makeLocalFakeContext(FAKE_LOCAL_STATE))

    const { handleStatus } = await import('../../src/mcp/tools/cli/status.js')
    const result = await handleStatus({ stackName: 'local-default' }, FAKE_SERVER)

    const text = (result.content[0] as { type: 'text'; text: string }).text
    const parsed = JSON.parse(text)
    expect(parsed.publicIp).toBe(FAKE_LOCAL_STATE.publicIp)
  })

  it('returns not-bootstrapped when local state is absent', async () => {
    const { buildContext } = await getMocks()
    buildContext.mockReturnValue(makeLocalFakeContext(null))

    const { handleStatus } = await import('../../src/mcp/tools/cli/status.js')
    const result = await handleStatus({ stackName: 'local-default' }, FAKE_SERVER)

    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(JSON.parse(text).status).toBe('not bootstrapped')
  })
})

describe('handleStacksList', () => {
  it('returns empty stacks when config is absent', async () => {
    const { getConfig } = await getMocks()
    getConfig.mockReturnValue(null)

    const { handleStacksList } = await import('../../src/mcp/tools/cli/stacks.js')
    const result = await handleStacksList({ fleet: false }, FAKE_SERVER)

    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(JSON.parse(text).stacks).toEqual([])
  })

  it('returns list of stacks from config', async () => {
    const { getConfig } = await getMocks()
    getConfig.mockReturnValue({
      ...MINIMAL_CONFIG,
      stacks: {
        'prod': { provider: 'aws', region: 'us-east-1', stateUrl: 's3://bucket', credentialsRef: { source: 'file', envVars: [] } },
      },
      defaults: { stack: 'prod', provider: 'aws' },
    })

    const { handleStacksList } = await import('../../src/mcp/tools/cli/stacks.js')
    const result = await handleStacksList({ fleet: false }, FAKE_SERVER)

    const text = (result.content[0] as { type: 'text'; text: string }).text
    const parsed = JSON.parse(text)
    expect(parsed.stacks).toHaveLength(1)
    expect(parsed.stacks[0].name).toBe('prod')
    expect(parsed.stacks[0].isDefault).toBe(true)
  })
})

describe('handleStatus — requests from the host agent (ADR 0014 §3)', () => {
  const request = {
    id: '1', at: '2026-10-17T10:00:00.000Z', tool: 'clawops_gateway_restart', stack: 'default',
    command: 'clawops gateway restart --stack default', needsValue: false,
  }

  async function status() {
    const { buildContext } = await getMocks()
    buildContext.mockReturnValue(makeFakeContext())
    const { handleStatus } = await import('../../src/mcp/tools/cli/status.js')
    const result = await handleStatus({ stackName: 'default' }, FAKE_SERVER)
    return JSON.parse((result.content[0] as { type: 'text'; text: string }).text)
  }

  it('reports them, so the operator\'s own agent sees what `status` shows', async () => {
    h.pendingOnHost.mockResolvedValue({ ok: true, value: [request] })
    expect((await status()).pendingHandoffs).toEqual([{ at: request.at, command: request.command }])
  })

  it('leaves the field out when there are none', async () => {
    expect(await status()).not.toHaveProperty('pendingHandoffs')
  })

  it('says when the host could not be asked', async () => {
    h.pendingOnHost.mockResolvedValue({ ok: false, error: 'connect ETIMEDOUT' })
    expect((await status()).pendingHandoffsError).toBe(
      'Could not check the host for requests from its agent: connect ETIMEDOUT',
    )
  })
})
