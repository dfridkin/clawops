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

// A config that is actually valid against the OpenClaw 2.0 schema. It used to set
// `models.maxAgents`, which does not exist in OpenClaw at all — the only `maxAgents` is
// under channels.feishu.dynamicAgentCreation. The hand-written validator had no way to
// know that; the schema-backed one rejected it the moment it was wired in.
const FAKE_CONFIG_JSON = JSON.stringify({
  meta: { lastTouchedVersion: '2026.9.2' },
  gateway: { mode: 'local', port: 18789, auth: { mode: 'token' } },
  models: { mode: 'merge' },
  channels: {},
})

/**
 * Answer the two commands readRemoteConfig runs: `uname -s` to pick the config path, then
 * a privileged `cat` of it. Matched on the command rather than queued in order — these
 * handlers used to be a one-element queue that answered `uname` with the config JSON and
 * left the `cat` unanswered.
 */
function serveConfig(session: FakeSshSession, json: string = FAKE_CONFIG_JSON): FakeSshSession {
  return session
    .respond(/uname -s/, { stdout: 'Linux' })
    .respond(/cat /, { stdout: json })
}

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
    serveConfig(session)
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
    serveConfig(session)
    const { acquireSession } = await getMocks()
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const { handleConfigGet } = await import('../../src/mcp/tools/cli/config.js')
    const result = await handleConfigGet({ stackName: 'default', key: 'gateway.port' }, makeServer())

    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(JSON.parse(text)).toBe(18789)
  })

  it('returns errText when config JSON is invalid', async () => {
    const session = new FakeSshSession()
    serveConfig(session, 'not json')
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
    serveConfig(session)
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
    serveConfig(session).respond(/base64 -d/, { code: 0 }) // read, then write
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
    serveConfig(session)
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
    const bad = JSON.stringify({ version: '2026.4', gateway: { mode: 'local' }, models: {}, channels: {} })
    const session = new FakeSshSession()
    serveConfig(session, bad)
    const { acquireSession } = await getMocks()
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const { handleConfigValidate } = await import('../../src/mcp/tools/cli/config.js')
    const result = await handleConfigValidate({ stackName: 'default' }, makeServer())
    const text = (result.content[0] as { type: 'text'; text: string }).text
    const parsed = JSON.parse(text) as { valid: boolean; issues: string[] }
    expect(parsed.valid).toBe(false)
    expect(parsed.issues.join(' ')).toMatch(/version/)
  })

  it('flags channels as array', async () => {
    const bad = JSON.stringify({ meta: { lastTouchedVersion: '2026.4' }, gateway: {}, models: {}, channels: [] })
    const session = new FakeSshSession()
    serveConfig(session, bad)
    const { acquireSession } = await getMocks()
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const { handleConfigValidate } = await import('../../src/mcp/tools/cli/config.js')
    const result = await handleConfigValidate({ stackName: 'default' }, makeServer())
    const text = (result.content[0] as { type: 'text'; text: string }).text
    const parsed = JSON.parse(text) as { valid: boolean; issues: string[] }
    expect(parsed.valid).toBe(false)
    expect(parsed.issues.join(' ')).toMatch(/channels/)
  })

  it('flags invalid gateway.auth.mode', async () => {
    const bad = JSON.stringify({ meta: {}, gateway: { auth: { mode: 'magic' } }, models: {}, channels: {} })
    const session = new FakeSshSession()
    serveConfig(session, bad)
    const { acquireSession } = await getMocks()
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const { handleConfigValidate } = await import('../../src/mcp/tools/cli/config.js')
    const result = await handleConfigValidate({ stackName: 'default' }, makeServer())
    const text = (result.content[0] as { type: 'text'; text: string }).text
    const parsed = JSON.parse(text) as { valid: boolean; issues: string[] }
    expect(parsed.valid).toBe(false)
    expect(parsed.issues.join(' ')).toMatch(/auth\.mode/)
  })
})

describe('handleConfigSet', () => {
  it('returns cancelled when elicitation is declined', async () => {
    const { handleConfigSet } = await import('../../src/mcp/tools/cli/config.js')
    const result = await handleConfigSet({ stackName: 'default', key: 'gateway.port', value: '19000', restart: false }, makeServer('decline'))
    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(text).toMatch(/cancel/i)
  })

  it('writes updated config and returns success', async () => {
    const session = new FakeSshSession()
    serveConfig(session).respond(/base64 -d/, { code: 0 }) // read, then write
    const { acquireSession } = await getMocks()
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const { handleConfigSet } = await import('../../src/mcp/tools/cli/config.js')
    const result = await handleConfigSet({ stackName: 'default', key: 'gateway.port', value: '19000', restart: false }, makeServer())
    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(text).toContain('gateway.port')
    expect(result.isError).toBeFalsy()
  })

  it('returns errText when write command fails', async () => {
    const session = new FakeSshSession()
    serveConfig(session).respond(/base64 -d/, { stderr: 'permission denied', code: 1 })
    const { acquireSession } = await getMocks()
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const { handleConfigSet } = await import('../../src/mcp/tools/cli/config.js')
    const result = await handleConfigSet({ stackName: 'default', key: 'x', value: 'y', restart: false }, makeServer())
    expect(result.isError).toBe(true)
  })
})

describe('config reads go through the shared reader', () => {
  // Not a style point. These four handlers used to `cat` a hardcoded Linux path with an
  // unprivileged exec, which is wrong on a macOS target and depended, on Linux, on the SSH
  // user happening to be uid 1000. remote-config.ts exists for exactly these callers.

  async function runGet(session: FakeSshSession) {
    const { acquireSession } = await getMocks()
    acquireSession.mockResolvedValue({ session, release: vi.fn() })
    const { handleConfigGet } = await import('../../src/mcp/tools/cli/config.js')
    return handleConfigGet({ stackName: 'default', key: '' }, makeServer())
  }

  it('detects the OS before choosing a config path', async () => {
    const session = serveConfig(new FakeSshSession())
    await runGet(session)
    expect(session.execCalls()[0]).toContain('uname -s')
  })

  it('reads the Linux config at the 2.0 state path', async () => {
    const session = serveConfig(new FakeSshSession())
    await runGet(session)
    expect(session.execCalls().find((c) => c.includes('cat '))).toContain(
      '/var/lib/clawops/openclaw/openclaw.json',
    )
  })

  it('escalates when the SSH user cannot read the config', async () => {
    // The state directory is owned by uid 1000 for the container. On a host where the SSH
    // user is not that uid, a plain `cat` is denied — which is what the hand-rolled read
    // did, and it had no second attempt.
    const session = new FakeSshSession()
      .respond(/uname -s/, { stdout: 'Linux' })
      .respond(/cat /, (cmd) =>
        cmd.includes('sudo')
          ? { stdout: FAKE_CONFIG_JSON, stderr: '', code: 0 }
          : { stdout: '', stderr: 'cat: Permission denied', code: 1 },
      )

    const result = await runGet(session)

    expect(result.isError).toBeFalsy()
    expect(JSON.parse((result.content[0] as { type: 'text'; text: string }).text).gateway).toBeDefined()
    expect(session.execCalls().some((c) => c.includes('sudo') && c.includes('cat '))).toBe(true)
  })

  it('reads the macOS path on a macOS target, and does not sudo', async () => {
    const session = new FakeSshSession()
      .respond(/uname -s/, { stdout: 'Darwin' })
      .respond(/cat /, { stdout: FAKE_CONFIG_JSON })
    await runGet(session)
    const read = session.execCalls().find((c) => c.includes('cat '))!
    expect(read).not.toContain('/var/lib/clawops')
    expect(read).not.toContain('sudo')
  })

  it('reports a read failure rather than reporting an empty config', async () => {
    const session = new FakeSshSession()
      .respond(/uname -s/, { stdout: 'Linux' })
      .respond(/cat /, { stdout: '', stderr: 'Permission denied', code: 1 })
    const result = await runGet(session)
    expect(result.isError).toBe(true)
    expect((result.content[0] as { type: 'text'; text: string }).text).toMatch(/Permission denied/)
  })

  it('answers "not valid" rather than erroring when validate cannot read the config', async () => {
    const session = new FakeSshSession()
      .respond(/uname -s/, { stdout: 'Linux' })
      .respond(/cat /, { stdout: '', stderr: 'Permission denied', code: 1 })
    const { acquireSession } = await getMocks()
    acquireSession.mockResolvedValue({ session, release: vi.fn() })
    const { handleConfigValidate } = await import('../../src/mcp/tools/cli/config.js')
    const result = await handleConfigValidate({ stackName: 'default' }, makeServer())
    const parsed = JSON.parse((result.content[0] as { type: 'text'; text: string }).text) as {
      valid: boolean
      issues: string[]
    }
    expect(parsed.valid).toBe(false)
    expect(parsed.issues.join(' ')).toMatch(/Permission denied/)
  })
})
