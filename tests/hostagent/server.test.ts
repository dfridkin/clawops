// Host-agent mode end to end through a real MCP server and client (ADR 0014).
//
// Each assertion here is about what the agent can and cannot make happen, so each one is made
// through tools/call rather than by calling a helper: the guard lives in dispatch, and a test
// that went around dispatch would pass with the guard deleted.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { registerTools, TOOL_REGISTRY_FOR_TESTS } from '../../src/mcp/tools/registry.js'
import { enterHostAgentMode, exitHostAgentModeForTests } from '../../src/hostagent/mode.js'
import { HOST_AGENT_READ_TOOLS, HANDOFF_TOOLS } from '../../src/hostagent/tools.js'
import type { HostAgentConfig } from '../../src/hostagent/config.js'
import { setGatewayConfigReaderForTests } from '../../src/hostagent/live.js'
import { CLAWOPS_TOOL_PATTERN } from '../../src/hostagent/guardrail.js'

/** A gateway where only the operator reaches `ops`. */
const GATEWAY_CONFIG = {
  agents: { entries: { main: { default: true, tools: { deny: [CLAWOPS_TOOL_PATTERN] } }, ops: {} } },
  bindings: [{ agentId: 'ops', match: { channel: 'telegram', peer: { kind: 'direct', id: '12345' } } }],
  channels: { telegram: { dmPolicy: 'pairing' } },
  tools: { agentToAgent: { enabled: false }, sessions: { visibility: 'agent' } },
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test configs are edited freely to break one condition
let gatewayConfig: Record<string, any>

const AGENT: HostAgentConfig = {
  version: 1,
  stack: 'prod',
  provider: 'aws',
  agentId: 'ops',
  operators: ['telegram:12345'],
  allow: ['clawops_gateway_restart', 'clawops_gateway_update', 'clawops_config_set'],
  strict: false,
  installedAt: '2026-10-16T00:00:00.000Z',
}

let home: string
const savedHome = process.env['CLAWOPS_HOME']

async function connect(config: HostAgentConfig = AGENT): Promise<Client> {
  enterHostAgentMode(config)
  const server = new McpServer({ name: 'clawops', version: 'test' })
  registerTools(server, {})
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  // Declares elicitation, and accepts everything: a host agent must not be swayed by it.
  const client = new Client({ name: 'gateway', version: 'test' }, { capabilities: { elicitation: {} } })
  client.setRequestHandler(
    (await import('@modelcontextprotocol/sdk/types.js')).ElicitRequestSchema,
    async () => ({ action: 'accept', content: { confirmed: true } }),
  )
  await client.connect(clientSide)
  return client
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as Array<{ type: string; text: string }>).map((c) => c.text).join('\n')
}

function handoffs(): Array<Record<string, unknown>> {
  const file = path.join(home, 'handoffs.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'clawops-agent-'))
  process.env['CLAWOPS_HOME'] = home
  gatewayConfig = structuredClone(GATEWAY_CONFIG)
  setGatewayConfigReaderForTests(async () => gatewayConfig)
})

afterEach(() => {
  exitHostAgentModeForTests()
  setGatewayConfigReaderForTests()
  rmSync(home, { recursive: true, force: true })
  if (savedHome === undefined) delete process.env['CLAWOPS_HOME']
  else process.env['CLAWOPS_HOME'] = savedHome
})

describe('host-agent tools/list', () => {
  it('serves the 12 read tools and only the destructive tools the operator allowed', async () => {
    const client = await connect()
    const names = (await client.listTools()).tools.map((t) => t.name).sort()
    expect(names).toEqual([...HOST_AGENT_READ_TOOLS, ...AGENT.allow].sort())
    expect(HOST_AGENT_READ_TOOLS).toHaveLength(12)
  })

  it('leaves out what needs the operator machine, and everything self-targeting', async () => {
    const client = await connect({ ...AGENT, allow: [...HANDOFF_TOOLS] })
    const names = (await client.listTools()).tools.map((t) => t.name)
    for (const absent of [
      'clawops_plan', 'clawops_secret_list', 'clawops_secret_audit',
      'clawops_destroy', 'clawops_stacks_delete', 'clawops_migrate',
      'clawops_up', 'clawops_apply', 'clawops_init', 'clawops_workflow_deploy_app',
    ]) {
      expect(names).not.toContain(absent)
    }
  })

  it('lists nothing destructive when nothing was allowed', async () => {
    const client = await connect({ ...AGENT, allow: [] })
    const { tools } = await client.listTools()
    expect(tools.filter((t) => t.annotations?.destructiveHint)).toEqual([])
  })
})

describe('a destructive call is handed off', () => {
  it('returns the CLI command and records it, without reaching the tool', async () => {
    const client = await connect()
    const result = await client.callTool({ name: 'clawops_gateway_restart', arguments: {} })
    expect(result.isError).toBeFalsy()
    expect(textOf(result)).toContain('clawops gateway restart --stack prod')
    expect(textOf(result)).toContain('Nothing was changed')
    expect(handoffs()).toEqual([
      expect.objectContaining({ tool: 'clawops_gateway_restart', stack: 'prod', command: 'clawops gateway restart --stack prod' }),
    ])
  })

  it('hands off the same command when yes: true is passed, and says it was ignored', async () => {
    const client = await connect()
    const args = { version: '2026.9.2' }
    const without = await client.callTool({ name: 'clawops_gateway_update', arguments: args })
    const result = await client.callTool({ name: 'clawops_gateway_update', arguments: { ...args, yes: true } })
    expect(textOf(result)).toContain('clawops gateway update 2026.9.2 --stack prod')
    expect(textOf(without)).toContain('clawops gateway update 2026.9.2 --stack prod')
    expect(textOf(without)).not.toContain('was ignored')
    expect(textOf(result)).toContain('`yes: true` was ignored')
  })

  it('keeps a secret value out of the result and out of handoffs.jsonl', async () => {
    const client = await connect()
    const marker = 'sk-live-HOSTAGENT-7f3a'
    const result = await client.callTool({
      name: 'clawops_config_set',
      arguments: { key: 'models.providers.openai.apiKey', value: marker },
    })
    expect(textOf(result)).toContain('clawops config set models.providers.openai.apiKey <value> --stack prod')
    expect(textOf(result)).not.toContain(marker)
    expect(readFileSync(path.join(home, 'handoffs.jsonl'), 'utf-8')).not.toContain(marker)
    expect(readFileSync(path.join(home, 'mcp-audit.log'), 'utf-8')).not.toContain(marker)
  })

  it('carries a non-secret value through, so the command does what the call asked', async () => {
    const client = await connect()
    const result = await client.callTool({
      name: 'clawops_config_set',
      arguments: { key: 'agents.defaults.model', value: 'openai/gpt-5', restart: true },
    })
    expect(textOf(result)).toContain('clawops config set agents.defaults.model openai/gpt-5 --stack prod --restart')
  })
})

describe('a host agent manages only its own stack', () => {
  it('refuses a call naming another stack, before any handler runs', async () => {
    const client = await connect()
    const result = await client.callTool({ name: 'clawops_gateway_restart', arguments: { stackName: 'staging' } })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('manages only stack "prod"')
    expect(handoffs()).toEqual([])
  })

  it('refuses a read naming another stack too', async () => {
    const client = await connect()
    const result = await client.callTool({ name: 'clawops_stacks_list', arguments: {} })
    expect(JSON.parse(textOf(result))).toEqual({
      stacks: [{ name: 'prod', provider: 'aws', isDefault: true, hostAgent: true }],
    })
    const other = await client.callTool({ name: 'clawops_status', arguments: { stackName: 'staging' } })
    expect(other.isError).toBe(true)
  })
})

describe('the self-targeting guard', () => {
  it('refuses with no command offered, whatever is allowed', async () => {
    // Not registered, so not callable by name; the dispatch guard is checked directly against
    // the real handler, which must never run.
    const { hostAgentDispatch } = await import('../../src/mcp/tools/registry.js')
    const handler = TOOL_REGISTRY_FOR_TESTS['clawops_destroy']!.handler
    let ran = false
    enterHostAgentMode(AGENT)
    const dispatch = hostAgentDispatch(AGENT, 'clawops_destroy', async (i, s) => { ran = true; return handler(i, s) })
    const result = await dispatch({ stackName: 'prod', yes: true }, {} as McpServer)
    expect(result.isError).toBe(true)
    expect(ran).toBe(false)
    expect(textOf(result)).not.toMatch(/clawops (destroy|down)/)
  })
})

describe('mcp serve --host-agent', () => {
  it('refuses toolset flags rather than quietly ignoring them', async () => {
    const { serveMcp } = await import('../../src/mcp/server.js')
    await expect(serveMcp({ hostAgent: true, readOnly: true })).rejects.toThrow(/tool set is fixed/)
    await expect(serveMcp({ hostAgent: true, toolsets: ['admin'] })).rejects.toThrow(/tool set is fixed/)
  })

  it('refuses to start without its configuration', async () => {
    const { serveMcp } = await import('../../src/mcp/server.js')
    process.env['CLAWOPS_AGENT_CONFIG'] = path.join(home, 'absent.json')
    await expect(serveMcp({ hostAgent: true })).rejects.toThrow(/clawops agent install/)
    delete process.env['CLAWOPS_AGENT_CONFIG']
  })
})

describe('the guardrail, checked on every call', () => {
  it('refuses every call once routing changes after install, and serves again once it is fixed', async () => {
    const client = await connect()
    expect((await client.callTool({ name: 'clawops_stacks_list', arguments: {} })).isError).toBeFalsy()

    // A group binding added after install, as `openclaw agents bind` would.
    gatewayConfig.bindings.push({ agentId: 'ops', match: { channel: 'telegram', peer: { kind: 'group', id: '-100' } } })
    for (const name of ['clawops_stacks_list', 'clawops_status', 'clawops_gateway_restart']) {
      const result = await client.callTool({ name, arguments: {} })
      expect(result.isError).toBe(true)
      expect(textOf(result)).toContain('answers only its operator')
    }
    expect(handoffs()).toEqual([])

    gatewayConfig.bindings.pop()
    expect((await client.callTool({ name: 'clawops_stacks_list', arguments: {} })).isError).toBeFalsy()
  })

  it('refuses when a new agent is added without the deny', async () => {
    const client = await connect()
    gatewayConfig.agents.entries.newbie = {}
    const result = await client.callTool({ name: 'clawops_logs_tail', arguments: {} })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('"newbie" can call clawops')
  })

  it('refuses when the gateway configuration cannot be read', async () => {
    const client = await connect()
    setGatewayConfigReaderForTests(async () => { throw new Error('permission denied') })
    const result = await client.callTool({ name: 'clawops_stacks_list', arguments: {} })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('could not be read: permission denied')
  })

  it('reports other agents with container access in status, and serves anyway by default', async () => {
    const client = await connect()
    const shown = JSON.parse(textOf(await client.callTool({ name: 'clawops_status', arguments: {} })))
    expect(shown.otherAgentsInContainer.join('\n')).toMatch(/"main" can run commands/)

    gatewayConfig.agents.entries.main.tools.profile = 'messaging'
    const contained = JSON.parse(textOf(await client.callTool({ name: 'clawops_status', arguments: {} })))
    expect(contained).not.toHaveProperty('otherAgentsInContainer')
  })

  it('refuses every call under --strict while another agent has container access', async () => {
    const client = await connect({ ...AGENT, strict: true })
    const refused = await client.callTool({ name: 'clawops_status', arguments: {} })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toMatch(/"main" can run commands.*clawops token/s)

    gatewayConfig.agents.entries.main.tools.profile = 'messaging'
    expect((await client.callTool({ name: 'clawops_status', arguments: {} })).isError).toBeFalsy()
  })
})
