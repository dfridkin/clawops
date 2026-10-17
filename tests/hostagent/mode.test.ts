// What host-agent mode changes below the tools: no clawops config, no Pulumi, no SSH.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { enterHostAgentMode, exitHostAgentModeForTests } from '../../src/hostagent/mode.js'
import { loadHostAgentConfig, type HostAgentConfig } from '../../src/hostagent/config.js'
import { buildContext } from '../../src/cli/context.js'
import { resolveConn, HOST_AGENT_CONN } from '../../src/transport/conn.js'
import { acquireSession } from '../../src/transport/pool.js'
import { redactConfigTree } from '../../src/mcp/audit.js'

const AGENT: HostAgentConfig = {
  version: 1, stack: 'prod', provider: 'gcp', agentId: 'ops', operators: ['telegram:1'],
  allow: [], strict: false, installedAt: '2026-10-16T00:00:00.000Z',
}

const savedHome = process.env['CLAWOPS_HOME']
afterEach(() => {
  exitHostAgentModeForTests()
  if (savedHome === undefined) delete process.env['CLAWOPS_HOME']
  else process.env['CLAWOPS_HOME'] = savedHome
})

describe('host-agent context', () => {
  it('needs no ~/.clawops config, and refuses to read Pulumi state', async () => {
    process.env['CLAWOPS_HOME'] = mkdtempSync(path.join(tmpdir(), 'empty-home-'))
    expect(() => buildContext({})).toThrow(/clawops init|config/i)

    enterHostAgentMode(AGENT)
    const ctx = buildContext({})
    expect(ctx.stackName).toBe('prod')
    expect(ctx.adapter.name).toBe('gcp')
    expect(ctx.config.stacks['prod']?.stateUrl).toBe('')
    await expect(ctx.getStack()).rejects.toThrow(/operator's machine/)
  })

  it('refuses another stack', () => {
    enterHostAgentMode(AGENT)
    expect(() => buildContext({ stack: 'staging' })).toThrow(/manages only stack "prod"/)
  })

  it('resolves no connection and opens no SSH session', async () => {
    enterHostAgentMode(AGENT)
    expect(await resolveConn(buildContext({}))).toBe(HOST_AGENT_CONN)
    // A host that does not exist: an SSH attempt would fail. The local session runs the command.
    const { session, release } = await acquireSession({
      host: '203.0.113.1', port: 22, user: 'x', privateKeyPath: '/nonexistent', knownHostsPath: '/nonexistent',
    })
    const result = await session.exec('echo here; echo err >&2; exit 3')
    release()
    expect(result).toEqual({ stdout: 'here\n', stderr: 'err\n', code: 3 })
  })

  it('does not change an ordinary process', async () => {
    const { NetworkError } = await import('../../src/errors/index.js')
    await expect(acquireSession({
      host: '203.0.113.1', port: 22, user: 'x', privateKeyPath: '/nonexistent', knownHostsPath: '/nonexistent',
    })).rejects.toBeInstanceOf(NetworkError)
  })
})

describe('host-agent config', () => {
  it('loads a valid file and refuses an invalid one with the field named', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'agent-cfg-'))
    const good = path.join(dir, 'good.json')
    writeFileSync(good, JSON.stringify(AGENT))
    expect(loadHostAgentConfig(good)).toEqual(AGENT)

    const bad = path.join(dir, 'bad.json')
    writeFileSync(bad, JSON.stringify({ ...AGENT, operators: [] }))
    expect(() => loadHostAgentConfig(bad)).toThrow(/operators/)
    expect(() => loadHostAgentConfig(path.join(dir, 'missing.json'))).toThrow(/clawops agent install/)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('config_get redaction for a host agent', () => {
  const marker = 'sk-live-REDACT-9c1e'
  const cfg = {
    models: {
      providers: {
        openai: { apiKey: marker, baseUrl: 'https://api.openai.com/v1', maxTokens: 4096 },
        anthropic: { apiKey: '${ANTHROPIC_API_KEY}' },
        bedrock: { apiKey: { source: 'env', id: 'AWS_PROFILE' } },
      },
    },
    channels: { telegram: { botToken: marker, dmPolicy: 'pairing' } },
  }

  it('hides literal secrets and keeps structure, numbers and references', () => {
    const shown = JSON.stringify(redactConfigTree(undefined, cfg))
    expect(shown).not.toContain(marker)
    expect(shown).toContain('https://api.openai.com/v1')
    expect(shown).toContain('4096')
    expect(shown).toContain('${ANTHROPIC_API_KEY}')
    expect(shown).toContain('"source":"env"')
    expect(shown).toContain('pairing')
  })

  it('hides a value asked for by its secret path', () => {
    expect(redactConfigTree('channels.telegram.botToken', marker)).toBe('[REDACTED]')
    expect(redactConfigTree('channels.telegram.dmPolicy', 'pairing')).toBe('pairing')
  })

  it('is what clawops_config_get returns in host-agent mode, and only there', async () => {
    vi.resetModules()
    vi.doMock('../../src/plan/remote-config.js', () => ({
      readRemoteConfig: async () => cfg, atomicWriteConfig: vi.fn(), restartGateway: vi.fn(),
    }))
    const mode = await import('../../src/hostagent/mode.js')
    const { handleConfigGet } = await import('../../src/mcp/tools/cli/config.js')
    mode.enterHostAgentMode(AGENT)
    const asAgent = await handleConfigGet({}, {} as never)
    mode.exitHostAgentModeForTests()
    expect(JSON.stringify(asAgent)).not.toContain(marker)
    expect(JSON.stringify(asAgent)).toContain('baseUrl')
    vi.doUnmock('../../src/plan/remote-config.js')
  })
})
