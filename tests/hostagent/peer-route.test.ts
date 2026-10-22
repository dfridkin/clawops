// Routing peer queries (ADR 0015 §3–§5), through a real MCP server and client. The peer itself is
// the fake: what it answers is set per test, and every call it would receive is recorded, so a
// test can say both what the calling host returned and whether anything left it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { registerTools, registerPeerTools } from '../../src/mcp/tools/registry.js'
import { enterHostAgentMode, exitHostAgentModeForTests } from '../../src/hostagent/mode.js'
import type { HostAgentConfig } from '../../src/hostagent/config.js'
import { setGatewayConfigReaderForTests } from '../../src/hostagent/live.js'
import { CLAWOPS_TOOL_PATTERN } from '../../src/hostagent/guardrail.js'
import { setPeerRouteDepsForTests, peerHostFrom } from '../../src/hostagent/peer-route.js'
import type { PeerAnswer, PeerCallRequest } from '../../src/hostagent/peer-client.js'
import type { FleetHost } from '../../src/hostagent/fleet-status.js'

const TAG = 'tag:clawops-agent'

/** A gateway where only the operator reaches `ops` and no other agent can act in the container. */
const GATEWAY = {
  agents: { entries: { main: { default: true, tools: { deny: [CLAWOPS_TOOL_PATTERN], profile: 'messaging' } }, ops: {} } },
  bindings: [{ agentId: 'ops', match: { channel: 'telegram', peer: { kind: 'direct', id: '12345' } } }],
  channels: { telegram: { dmPolicy: 'pairing' } },
  tools: { agentToAgent: { enabled: false }, sessions: { visibility: 'agent' } },
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- edited freely to break one condition
let gateway: Record<string, any>

const US: HostAgentConfig = {
  version: 1,
  stack: 'us',
  provider: 'aws',
  agentId: 'ops',
  operators: ['telegram:12345'],
  allow: ['clawops_gateway_restart', 'clawops_config_set'],
  strict: true,
  fleet: { serves: TAG, peers: [{ stack: 'eu', node: 'eu-gw' }, { stack: 'ap', node: 'ap-gw' }], peerUid: 998 },
  installedAt: '2026-10-21T00:00:00.000Z',
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
const answered = (t: string, by = 'eu-gw.tail1234.ts.net'): PeerAnswer => ({ ok: true, answeredBy: by, result: text(t) })

let calls: PeerCallRequest[]
let answer: (req: PeerCallRequest) => PeerAnswer
let table: { ok: true } | { ok: false; reason: string }
let thisHost: FleetHost
let home: string
const savedHome = process.env['CLAWOPS_HOME']

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'clawops-route-'))
  process.env['CLAWOPS_HOME'] = home
  gateway = structuredClone(GATEWAY)
  setGatewayConfigReaderForTests(async () => gateway)
  calls = []
  answer = () => answered('{"status":"running"}')
  table = { ok: true }
  thisHost = {
    stack: 'us', state: 'ok', service: 'active', agentId: 'ops', strict: true, problems: [],
    fleet: { serves: TAG, peers: US.fleet!.peers, firewall: 'ok', tailnet: { state: 'Running', dnsName: 'us-gw.tail1234.ts.net', tags: [TAG] } },
  }
  setPeerRouteDepsForTests({
    call: async (req) => { calls.push(req); return answer(req) },
    table: async () => table,
    thisHost: async () => thisHost,
  })
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})

afterEach(() => {
  exitHostAgentModeForTests()
  setGatewayConfigReaderForTests()
  setPeerRouteDepsForTests()
  vi.restoreAllMocks()
  if (savedHome === undefined) delete process.env['CLAWOPS_HOME']
  else process.env['CLAWOPS_HOME'] = savedHome
  rmSync(home, { recursive: true, force: true })
})

async function connect(config: HostAgentConfig = US, register: (s: McpServer) => void = (s) => registerTools(s, {})): Promise<Client> {
  enterHostAgentMode(config)
  const server = new McpServer({ name: 'clawops', version: 'test' })
  register(server)
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: 'gateway', version: 'test' })
  await client.connect(clientSide)
  return client
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as Array<{ type: string; text: string }>).map((c) => c.text).join('\n')
}

function audit(): Array<Record<string, unknown>> {
  const file = path.join(home, 'mcp-audit.log')
  return existsSync(file) ? readFileSync(file, 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>) : []
}

describe('a read naming a peer', () => {
  it('goes to that peer by its tailnet name, about the peer\'s own stack, and says who answered', async () => {
    const c = await connect()
    const r = await c.callTool({ name: 'clawops_gateway_status', arguments: { stackName: 'eu' } })
    expect(r.isError).toBeFalsy()
    expect(calls).toEqual([{ node: 'eu-gw', tool: 'clawops_gateway_status', args: { stackName: 'eu' } }])
    expect(textOf(r)).toBe('Answered by peer eu (eu-gw.tail1234.ts.net).\n\n{"status":"running"}')
  })

  it('is recorded with the peer it went to', async () => {
    const c = await connect()
    await c.callTool({ name: 'clawops_gateway_status', arguments: { stackName: 'eu' } })
    expect(audit()).toEqual([expect.objectContaining({ tool: 'clawops_gateway_status', result: 'ok', forwardedTo: { stack: 'eu', node: 'eu-gw' } })])
  })

  it('carries the peer\'s refusal back as a refusal', async () => {
    answer = () => ({ ok: true, answeredBy: 'eu-gw.tail1234.ts.net', result: { ...text('This host agent manages only stack "eu".'), isError: true } })
    const r = await (await connect()).callTool({ name: 'clawops_gateway_status', arguments: { stackName: 'eu' } })
    expect(r.isError).toBe(true)
  })

  it('says the peer did not answer, and why', async () => {
    answer = () => ({ ok: false, reason: 'eu-gw.tail1234.ts.net did not answer after 2 attempts: no answer within 7 s' })
    const r = await (await connect()).callTool({ name: 'clawops_gateway_status', arguments: { stackName: 'eu' } })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toBe('Peer eu (eu-gw) did not answer: eu-gw.tail1234.ts.net did not answer after 2 attempts: no answer within 7 s')
    expect(audit()[0]).toMatchObject({ result: 'error', forwardedTo: { stack: 'eu' } })
  })

  it('keeps a large answer within 8 KB', async () => {
    answer = () => answered('x'.repeat(20_000))
    const r = await (await connect()).callTool({ name: 'clawops_gateway_status', arguments: { stackName: 'eu' } })
    expect(Buffer.byteLength(textOf(r))).toBeLessThanOrEqual(8 * 1024)
    expect(textOf(r)).toMatch(/cut to fit 8 KB/)
  })

  it('leaves a call about this host, or about no stack, on this host', async () => {
    const c = await connect()
    await c.callTool({ name: 'clawops_config_get', arguments: { stackName: 'us', key: 'gateway.port' } })
    await c.callTool({ name: 'clawops_config_get', arguments: { key: 'gateway.port' } })
    expect(calls).toEqual([])
  })

  it('refuses a stack that is neither this host nor a peer, as before', async () => {
    const r = await (await connect()).callTool({ name: 'clawops_gateway_status', arguments: { stackName: 'staging' } })
    expect(textOf(r)).toMatch(/manages only stack "us"/)
    expect(calls).toEqual([])
  })
})

describe('when no peer may be asked', () => {
  it('asks nothing while the guardrail fails', async () => {
    gateway.bindings = []
    const r = await (await connect()).callTool({ name: 'clawops_gateway_status', arguments: { stackName: 'eu' } })
    expect(r.isError).toBe(true)
    expect(calls).toEqual([])
  })

  it('asks nothing while another agent can act in this gateway\'s container', async () => {
    delete gateway.agents.entries.main.tools.profile
    const r = await (await connect()).callTool({ name: 'clawops_gateway_status', arguments: { stackName: 'eu' } })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toMatch(/"main" can run commands/)
    expect(calls).toEqual([])
  })

  it('asks nothing from a host agent whose agent.json lost --strict', async () => {
    const r = await (await connect({ ...US, strict: false })).callTool({ name: 'clawops_gateway_status', arguments: { stackName: 'eu' } })
    expect(textOf(r)).toMatch(/installed without --strict/)
    expect(calls).toEqual([])
  })

  it('asks nothing while the firewall table is missing or changed', async () => {
    table = { ok: false, reason: 'The table inet clawops_peer is missing.' }
    const r = await (await connect()).callTool({ name: 'clawops_gateway_status', arguments: { stackName: 'eu' } })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toBe('Refused: peer queries need the fleet firewall table, and the table inet clawops_peer is missing. Run `clawops agent install` again to restore it.')
    expect(calls).toEqual([])
  })
})

describe('a destructive call naming a peer', () => {
  it('is refused with the operator\'s command, asks the peer nothing, and records no handoff', async () => {
    const r = await (await connect()).callTool({ name: 'clawops_gateway_restart', arguments: { stackName: 'eu' } })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toMatch(/"eu" is a peer, and a host agent only reads its peers/)
    expect(textOf(r)).toContain('clawops gateway restart --stack eu')
    expect(calls).toEqual([])
    expect(existsSync(path.join(home, 'handoffs.jsonl'))).toBe(false)
  })

  it('keeps a secret out of the command it shows', async () => {
    const r = await (await connect()).callTool({ name: 'clawops_config_set', arguments: { stackName: 'eu', key: 'models.providers.openai.apiKey', value: 'sk-live-123' } })
    expect(textOf(r)).not.toContain('sk-live-123')
    expect(textOf(r)).toContain('<value>')
  })

  it('is refused while this host\'s own call is still handed off as before', async () => {
    const r = await (await connect()).callTool({ name: 'clawops_gateway_restart', arguments: { stackName: 'us' } })
    expect(textOf(r)).toContain('clawops gateway restart --stack us')
    expect(existsSync(path.join(home, 'handoffs.jsonl'))).toBe(true)
  })
})

describe('clawops_stacks_list on a host agent with peers', () => {
  it('lists this host and each peer, and whether each answered', async () => {
    answer = (req) => (req.node === 'eu-gw' ? answered('{"stacks":[]}') : { ok: false, reason: 'ap-gw did not answer after 2 attempts: ECONNREFUSED' })
    const r = await (await connect()).callTool({ name: 'clawops_stacks_list', arguments: {} })
    expect(r.isError).toBeFalsy()
    expect(JSON.parse(textOf(r))).toEqual({
      stacks: [
        { name: 'us', provider: 'aws', isDefault: true, hostAgent: true },
        { name: 'eu', peer: 'eu-gw', answered: true, answeredBy: 'eu-gw.tail1234.ts.net' },
        { name: 'ap', peer: 'ap-gw', answered: false, note: 'ap-gw did not answer after 2 attempts: ECONNREFUSED' },
      ],
    })
    expect(calls.map((c) => [c.node, c.tool, c.args['fleet']])).toEqual([['eu-gw', 'clawops_stacks_list', undefined], ['ap-gw', 'clawops_stacks_list', undefined]])
  })

  it('reports peers as unanswered, not asked, while the table is missing', async () => {
    table = { ok: false, reason: 'The table inet clawops_peer is missing.' }
    const r = await (await connect()).callTool({ name: 'clawops_stacks_list', arguments: {} })
    expect(JSON.parse(textOf(r)).stacks[1]).toMatchObject({ name: 'eu', answered: false, note: expect.stringMatching(/firewall table/) })
    expect(calls).toEqual([])
  })

  it('reads only the stacks named, and refuses one it does not know', async () => {
    const c = await connect()
    const r = await c.callTool({ name: 'clawops_stacks_list', arguments: { stackNames: 'eu' } })
    expect(JSON.parse(textOf(r)).stacks.map((s: { name: string }) => s.name)).toEqual(['eu'])
    const bad = await c.callTool({ name: 'clawops_stacks_list', arguments: { stackNames: 'eu,staging' } })
    expect(bad.isError).toBe(true)
    expect(textOf(bad)).toMatch(/knows only stack "us" and its peers \(eu, ap\); not "staging"/)
  })

  it('lists only this host where there are no peers', async () => {
    const plain: HostAgentConfig = { ...US }
    delete plain.fleet
    const r = await (await connect(plain)).callTool({ name: 'clawops_stacks_list', arguments: {} })
    expect(JSON.parse(textOf(r)).stacks).toEqual([{ name: 'us', provider: 'aws', isDefault: true, hostAgent: true }])
  })
})

describe('clawops_stacks_list with fleet: true on a host agent', () => {
  const peerHost = (stack: string, serves?: string): FleetHost => ({
    stack, state: 'ok', service: 'active', agentId: 'ops', strict: true, problems: [],
    fleet: { ...(serves ? { serves } : {}), peers: [], firewall: 'ok', tailnet: { state: 'Running', dnsName: `${stack}-gw.tail1234.ts.net`, tags: [TAG] } },
  })

  it('answers for this host and each peer as it reports itself, checked against each other', async () => {
    answer = (req) => req.node === 'eu-gw'
      ? answered(JSON.stringify({ host: peerHost('eu', TAG) }))
      // ap was installed without --serve-peers: the problem is this host's, which names it.
      : answered(JSON.stringify({ host: peerHost('ap') }), 'ap-gw.tail1234.ts.net')
    const r = await (await connect()).callTool({ name: 'clawops_stacks_list', arguments: { fleet: true } })
    const { fleet } = JSON.parse(textOf(r)) as { fleet: { hosts: FleetHost[]; agents: number; members: number } }
    expect(fleet.hosts.map((h) => [h.stack, h.state])).toEqual([['us', 'problems'], ['eu', 'ok'], ['ap', 'ok']])
    expect(fleet.hosts[0]!.problems).toEqual(['Peer ap does not serve peers: its host agent was installed without --serve-peers.'])
    expect(fleet).toMatchObject({ agents: 3, members: 3 })
    expect(calls.every((c) => c.tool === 'clawops_stacks_list' && c.args['fleet'] === true)).toBe(true)
  })

  it('reports a peer that did not answer as unreachable, and does not judge it', async () => {
    answer = (req) => (req.node === 'eu-gw' ? { ok: false, reason: 'no answer within 7 s' } : answered(JSON.stringify({ host: peerHost('ap', TAG) })))
    const { fleet } = JSON.parse(textOf(await (await connect()).callTool({ name: 'clawops_stacks_list', arguments: { fleet: true } }))) as { fleet: { hosts: FleetHost[] } }
    expect(fleet.hosts[1]).toEqual({ stack: 'eu', state: 'unreachable', problems: ['no answer within 7 s'] })
    expect(fleet.hosts[0]!.state).toBe('ok')
  })
})

describe('a peer\'s account of itself', () => {
  const peer = { stack: 'eu', node: 'eu-gw' }
  it('is taken when it is a host with the peer\'s stack', () => {
    const h: FleetHost = { stack: 'eu', state: 'ok', problems: [] }
    expect(peerHostFrom(peer, answered(JSON.stringify({ host: h })))).toEqual(h)
  })

  it('is reported, not trusted, when it is anything else', () => {
    expect(peerHostFrom(peer, answered('not json'))).toMatchObject({ state: 'unreachable', problems: [expect.stringMatching(/did not report itself: not json/)] })
    expect(peerHostFrom(peer, answered(JSON.stringify({ host: { stack: 'eu', state: 'fine', problems: [] } })))).toMatchObject({ state: 'unreachable' })
    expect(peerHostFrom(peer, answered(JSON.stringify({ host: { stack: 'us', state: 'ok', problems: [] } })))).toEqual({
      stack: 'eu', state: 'problems', problems: ['eu-gw.tail1234.ts.net answers as stack "us", not "eu". Check the --peer entry.'],
    })
  })
})

describe('the peer listener\'s stacks list', () => {
  const caller = { name: 'us-gw.tail1234.ts.net', stableId: 'nUS', tags: [TAG] }

  it('answers fleet: true for its own host only, and asks no peer of its own', async () => {
    const eu: HostAgentConfig = { ...US, stack: 'eu', fleet: { serves: TAG, peers: [{ stack: 'us', node: 'us-gw' }], peerUid: 998 } }
    thisHost = { stack: 'eu', state: 'ok', problems: [] }
    const c = await connect(eu, (s) => registerPeerTools(s, eu, caller))
    const r = await c.callTool({ name: 'clawops_stacks_list', arguments: { fleet: true } })
    expect(JSON.parse(textOf(r))).toEqual({ host: { stack: 'eu', state: 'ok', problems: [] } })
    expect(calls).toEqual([])
  })

  it('forwards nothing a peer names: a read about another stack is refused', async () => {
    const eu: HostAgentConfig = { ...US, stack: 'eu', fleet: { serves: TAG, peers: [{ stack: 'us', node: 'us-gw' }], peerUid: 998 } }
    const c = await connect(eu, (s) => registerPeerTools(s, eu, caller))
    const r = await c.callTool({ name: 'clawops_gateway_status', arguments: { stackName: 'us' } })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toMatch(/manages only stack "eu"/)
    expect(calls).toEqual([])
  })
})
