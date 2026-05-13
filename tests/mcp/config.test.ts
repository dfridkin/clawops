import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { makeFakeContext } from '../helpers/context.js'
import { FakeSshSession } from '../helpers/ssh.js'
import { FAKE_CONN } from '../helpers/context.js'

vi.mock('../../src/cli/context.js', () => ({ buildContext: vi.fn() }))
vi.mock('../../src/transport/pool.js', () => ({ acquireSession: vi.fn(), drainPool: vi.fn() }))
vi.mock('../../src/mcp/tools/_conn.js', () => ({
  resolveConn: vi.fn(),
  okText: vi.fn(t => ({ content: [{ type: 'text', text: t }] })),
  errText: vi.fn(t => ({ content: [{ type: 'text', text: t }], isError: true })),
}))

const FAKE_CONFIG_JSON = JSON.stringify({
  meta: { lastTouchedVersion: '2026.4' },
  gateway: { port: 18789, auth: { mode: 'token' } },
  models: { maxAgents: 4 },
  channels: {},
})

function makeServer(action: 'accept' | 'decline' = 'accept'): McpServer {
  return {
    server: {
      elicitInput: vi.fn().mockResolvedValue({ action, content: { confirmed: true } }),
      notification: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as McpServer
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
  const { buildContext, resolveConn } = await getMocks()
  buildContext.mockReturnValue(makeFakeContext())
  resolveConn.mockResolvedValue(FAKE_CONN)
})

describe('handleConfigGet', () => {
  it('returns full config when no key is specified', async () => {
    const session = new FakeSshSession()
    session.onExec(() => ({ stdout: FAKE_CONFIG_JSON, stderr: '', code: 0 }))
    const { acquireSession } = await getMocks()
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const { handleConfigGet } = await import('../../src/mcp/tools/cli/config.js')
    const result = await handleConfigGet({ stackName: 'default', key: '' }, makeServer())

    const text = (result.content[0] as { type: 'text'; text: string }).text
    const parsed = JSON.parse(text)
    expect(parsed.gateway).toBeDefined()
    expect(result.isError).toBeFalsy()
  })

  it('returns nested value when key is specified', async () => {
    const session = new FakeSshSession()
    session.onExec(() => ({ stdout: FAKE_CONFIG_JSON, stderr: '', code: 0 }))
    const { acquireSession } = await getMocks()
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const { handleConfigGet } = await import('../../src/mcp/tools/cli/config.js')
    const result = await handleConfigGet({ stackName: 'default', key: 'models.maxAgents' }, makeServer())

    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(JSON.parse(text)).toBe(4)
  })

  it('returns errText when config JSON is invalid', async () => {
    const session = new FakeSshSession()
    session.onExec(() => ({ stdout: 'not json', stderr: '', code: 0 }))
    const { acquireSession } = await getMocks()
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const { handleConfigGet } = await import('../../src/mcp/tools/cli/config.js')
    const result = await handleConfigGet({ stackName: 'default', key: '' }, makeServer())
    expect(result.isError).toBe(true)
  })
})

describe('handleConfigGet (no key)', () => {
  it('returns full config when key is undefined', async () => {
    const session = new FakeSshSession()
    session.onExec(() => ({ stdout: FAKE_CONFIG_JSON, stderr: '', code: 0 }))
    const { acquireSession } = await getMocks()
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const { handleConfigGet } = await import('../../src/mcp/tools/cli/config.js')
    const result = await handleConfigGet({ stackName: 'default' }, makeServer())

    const text = (result.content[0] as { type: 'text'; text: string }).text
    const parsed = JSON.parse(text)
    expect(parsed.meta).toBeDefined()
    expect(parsed.channels).toBeDefined()
    expect(result.isError).toBeFalsy()
  })
})

describe('handleConfigUnset', () => {
  it('returns cancelled when elicitation is declined', async () => {
    const { handleConfigUnset } = await import('../../src/mcp/tools/cli/config.js')
    const result = await handleConfigUnset({ stackName: 'default', key: 'models', restart: false }, makeServer('decline'))
    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(text).toMatch(/cancel/i)
  })

  it('removes key and writes back', async () => {
    const session = new FakeSshSession()
    session.onExec(() => ({ stdout: FAKE_CONFIG_JSON, stderr: '', code: 0 })) // read
    session.onExec(() => ({ stdout: '', stderr: '', code: 0 })) // write
    const { acquireSession } = await getMocks()
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const { handleConfigUnset } = await import('../../src/mcp/tools/cli/config.js')
    const result = await handleConfigUnset({ stackName: 'default', key: 'models', restart: false }, makeServer())
    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(text).toContain('models')
    expect(result.isError).toBeFalsy()
  })
})

describe('handleConfigValidate', () => {
  it('returns valid=true for a well-formed config', async () => {
    const session = new FakeSshSession()
    session.onExec(() => ({ stdout: FAKE_CONFIG_JSON, stderr: '', code: 0 }))
    const { acquireSession } = await getMocks()
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const { handleConfigValidate } = await import('../../src/mcp/tools/cli/config.js')
    const result = await handleConfigValidate({ stackName: 'default' }, makeServer())
    const text = (result.content[0] as { type: 'text'; text: string }).text
    const parsed = JSON.parse(text) as { valid: boolean; issues: string[] }
    expect(parsed.valid).toBe(true)
    expect(parsed.issues).toHaveLength(0)
  })

  it('flags top-level version key', async () => {
    const bad = JSON.stringify({ version: '2026.4', gateway: {}, models: {}, channels: {} })
    const session = new FakeSshSession()
    session.onExec(() => ({ stdout: bad, stderr: '', code: 0 }))
    const { acquireSession } = await getMocks()
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const { handleConfigValidate } = await import('../../src/mcp/tools/cli/config.js')
    const result = await handleConfigValidate({ stackName: 'default' }, makeServer())
    const text = (result.content[0] as { type: 'text'; text: string }).text
    const parsed = JSON.parse(text) as { valid: boolean; issues: string[] }
    expect(parsed.valid).toBe(false)
    expect(parsed.issues[0]).toMatch(/version/)
  })

  it('flags channels as array', async () => {
    const bad = JSON.stringify({ meta: { lastTouchedVersion: '2026.4' }, gateway: {}, models: {}, channels: [] })
    const session = new FakeSshSession()
    session.onExec(() => ({ stdout: bad, stderr: '', code: 0 }))
    const { acquireSession } = await getMocks()
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const { handleConfigValidate } = await import('../../src/mcp/tools/cli/config.js')
    const result = await handleConfigValidate({ stackName: 'default' }, makeServer())
    const text = (result.content[0] as { type: 'text'; text: string }).text
    const parsed = JSON.parse(text) as { valid: boolean; issues: string[] }
    expect(parsed.valid).toBe(false)
    expect(parsed.issues[0]).toMatch(/channels/)
  })

  it('flags invalid gateway.auth.mode', async () => {
    const bad = JSON.stringify({ meta: {}, gateway: { auth: { mode: 'magic' } }, models: {}, channels: {} })
    const session = new FakeSshSession()
    session.onExec(() => ({ stdout: bad, stderr: '', code: 0 }))
    const { acquireSession } = await getMocks()
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const { handleConfigValidate } = await import('../../src/mcp/tools/cli/config.js')
    const result = await handleConfigValidate({ stackName: 'default' }, makeServer())
    const text = (result.content[0] as { type: 'text'; text: string }).text
    const parsed = JSON.parse(text) as { valid: boolean; issues: string[] }
    expect(parsed.valid).toBe(false)
    expect(parsed.issues[0]).toMatch(/auth\.mode/)
  })
})

describe('handleConfigSet', () => {
  it('returns cancelled when elicitation is declined', async () => {
    const { handleConfigSet } = await import('../../src/mcp/tools/cli/config.js')
    const result = await handleConfigSet({ stackName: 'default', key: 'models.maxAgents', value: '8', restart: false }, makeServer('decline'))
    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(text).toMatch(/cancel/i)
  })

  it('writes updated config and returns success', async () => {
    const session = new FakeSshSession()
    session.onExec(() => ({ stdout: FAKE_CONFIG_JSON, stderr: '', code: 0 })) // read
    session.onExec(() => ({ stdout: 'Linux', stderr: '', code: 0 }))          // uname -s (detectOS)
    session.onExec(() => ({ stdout: '', stderr: '', code: 0 }))               // write
    const { acquireSession } = await getMocks()
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const { handleConfigSet } = await import('../../src/mcp/tools/cli/config.js')
    const result = await handleConfigSet({ stackName: 'default', key: 'models.maxAgents', value: '8', restart: false }, makeServer())
    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(text).toContain('models.maxAgents')
    expect(result.isError).toBeFalsy()
  })

  it('returns errText when write command fails', async () => {
    const session = new FakeSshSession()
    session.onExec(() => ({ stdout: FAKE_CONFIG_JSON, stderr: '', code: 0 }))      // read
    session.onExec(() => ({ stdout: 'Linux', stderr: '', code: 0 }))               // uname -s (detectOS)
    session.onExec(() => ({ stdout: '', stderr: 'permission denied', code: 1 }))
    const { acquireSession } = await getMocks()
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const { handleConfigSet } = await import('../../src/mcp/tools/cli/config.js')
    const result = await handleConfigSet({ stackName: 'default', key: 'x', value: 'y', restart: false }, makeServer())
    expect(result.isError).toBe(true)
  })
})
