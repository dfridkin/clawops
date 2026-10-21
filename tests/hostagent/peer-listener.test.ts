// The peer listener (ADR 0015 §2 and §3), through a real HTTP server on loopback and a real MCP
// client. tailscaled is the one fake: what it says about a caller is set per test, and each test
// changes one thing about the caller.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { connect as netConnect } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  authorizePeer, createPeerHandler, listenPeers, peerListenAddresses, plainAddress, startPeerListener,
  type PeerAuthDeps, type PeerListener,
} from '../../src/hostagent/peer-listener.js'
import { registerPeerTools } from '../../src/mcp/tools/registry.js'
import { enterHostAgentMode, exitHostAgentModeForTests } from '../../src/hostagent/mode.js'
import { HOST_AGENT_READ_TOOLS } from '../../src/hostagent/tools.js'
import type { HostAgentConfig } from '../../src/hostagent/config.js'
import type { WhoisResult, SelfResult } from '../../src/hostagent/tailscaled.js'

const TAG = 'tag:clawops-agent'
const SELF_ID = 'nSELF'

const AGENT: HostAgentConfig = {
  version: 1,
  stack: 'eu',
  provider: 'aws',
  agentId: 'ops',
  operators: ['telegram:12345'],
  // Allowed for the host's own agent. A peer must get none of them.
  allow: ['clawops_gateway_restart', 'clawops_config_set'],
  strict: true,
  fleet: { serves: TAG, peers: [], peerUid: 998 },
  installedAt: '2026-10-21T00:00:00.000Z',
}

const PEER: WhoisResult = { kind: 'node', node: { stableId: 'nUS', name: 'us-gw.tail1234.ts.net', tags: [TAG] } }
const RUNNING: SelfResult = { ok: true, self: { state: 'Running', stableId: SELF_ID, ips: ['100.64.0.2'], tun: true } }

function fakeTailscaled(who: WhoisResult = PEER, me: SelfResult = RUNNING) {
  const lookups: Array<{ address: string; port: number }> = []
  const deps: PeerAuthDeps & { who: WhoisResult; me: SelfResult } = {
    who,
    me,
    async whois(address, port) { lookups.push({ address, port }); return deps.who },
    async self() { return deps.me },
  }
  return { deps, lookups }
}

let home: string
const savedHome = process.env['CLAWOPS_HOME']
let listener: PeerListener | undefined

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'clawops-peer-'))
  process.env['CLAWOPS_HOME'] = home
  enterHostAgentMode(AGENT)
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})

afterEach(async () => {
  await listener?.close()
  listener = undefined
  exitHostAgentModeForTests()
  vi.restoreAllMocks()
  if (savedHome === undefined) delete process.env['CLAWOPS_HOME']
  else process.env['CLAWOPS_HOME'] = savedHome
  rmSync(home, { recursive: true, force: true })
})

async function serve(deps: PeerAuthDeps, opts: { maxLookups?: number; capMs?: number } = {}): Promise<string> {
  const handler = createPeerHandler({
    serves: TAG,
    deps,
    maxLookups: opts.maxLookups,
    makeServer: (caller) => {
      const server = new McpServer({ name: 'clawops', version: 'test' })
      registerPeerTools(server, AGENT, caller)
      return server
    },
  })
  listener = await listenPeers(['127.0.0.1'], handler, { port: 0, capMs: opts.capMs, log: () => {} })
  return `http://127.0.0.1:${listener.port}/`
}

async function client(url: string): Promise<Client> {
  const c = new Client({ name: 'us', version: 'test' })
  await c.connect(new StreamableHTTPClientTransport(new URL(url)))
  return c
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as Array<{ type: string; text: string }>).map((c) => c.text).join('\n')
}

function audit(): Array<Record<string, unknown>> {
  const file = path.join(home, 'mcp-audit.log')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
}

/** A raw POST, for the refusals, which come before any MCP exchange. */
function post(url: string, body: string, localPort?: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, ...(localPort ? { localPort } : {}) }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

const INIT = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '1' } } })

describe('who the peer listener answers', () => {
  it('answers a tailnet node that carries the tag and is not this host', async () => {
    expect(await authorizePeer(TAG, '100.64.0.1', 41000, fakeTailscaled().deps)).toEqual({
      ok: true,
      caller: { name: 'us-gw.tail1234.ts.net', stableId: 'nUS', tags: [TAG] },
    })
  })

  it('refuses an address that is no tailnet node, such as a LAN neighbour', async () => {
    const r = await authorizePeer(TAG, '192.168.1.7', 41000, fakeTailscaled({ kind: 'none' }).deps)
    expect(r).toEqual({ ok: false, status: 403, reason: expect.stringMatching(/192\.168\.1\.7:41000 is not a tailnet node/) })
  })

  it('refuses an untagged node', async () => {
    const r = await authorizePeer(TAG, '100.64.0.3', 41000, fakeTailscaled({ kind: 'node', node: { stableId: 'nLAPTOP', name: 'laptop', tags: [] } }).deps)
    expect(r).toMatchObject({ ok: false, status: 403, reason: 'Refused: laptop does not carry tag:clawops-agent (its tags: none).' })
  })

  it('refuses a node with another tag', async () => {
    const r = await authorizePeer(TAG, '100.64.0.4', 41000, fakeTailscaled({ kind: 'node', node: { stableId: 'nCI', name: 'ci', tags: ['tag:ci'] } }).deps)
    expect(r).toMatchObject({ ok: false, status: 403, reason: expect.stringMatching(/ci does not carry tag:clawops-agent \(its tags: tag:ci\)/) })
  })

  it('refuses this host, tag and all, by StableID', async () => {
    const r = await authorizePeer(TAG, '100.64.0.2', 41000, fakeTailscaled({ kind: 'node', node: { stableId: SELF_ID, name: 'eu-gw', tags: [TAG] } }).deps)
    expect(r).toMatchObject({ ok: false, status: 403, reason: expect.stringMatching(/the caller is this host/), caller: { stableId: SELF_ID } })
  })

  it('refuses when this host\'s own identity cannot be read, since self could not be told apart', async () => {
    const noId = await authorizePeer(TAG, '100.64.0.1', 41000, fakeTailscaled(PEER, { ok: true, self: { state: 'Running', ips: [], tun: true } }).deps)
    expect(noId).toMatchObject({ ok: false, status: 503, reason: expect.stringMatching(/no StableID/) })
    const down = await authorizePeer(TAG, '100.64.0.1', 41000, fakeTailscaled(PEER, { ok: false, reason: 'tailscaled did not answer: ENOENT' }).deps)
    expect(down).toMatchObject({ ok: false, status: 503, reason: expect.stringMatching(/ENOENT/) })
  })

  it('refuses when tailscaled cannot be asked', async () => {
    const r = await authorizePeer(TAG, '100.64.0.1', 41000, fakeTailscaled({ kind: 'error', reason: 'tailscaled could not be asked who is calling: ECONNREFUSED' }).deps)
    expect(r).toEqual({ ok: false, status: 503, reason: expect.stringMatching(/ECONNREFUSED/) })
  })

  it('asks about IPv4 callers by their IPv4 address', () => {
    expect(plainAddress('::ffff:100.64.0.1')).toBe('100.64.0.1')
    expect(plainAddress('fd7a:115c:a1e0::1')).toBe('fd7a:115c:a1e0::1')
  })
})

describe('the peer listener, over HTTP', () => {
  it('serves exactly the read tools, none of the handoffs the host\'s own agent was allowed', async () => {
    const c = await client(await serve(fakeTailscaled().deps))
    const names = (await c.listTools()).tools.map((t) => t.name).sort()
    expect(names).toEqual([...HOST_AGENT_READ_TOOLS].sort())
    expect(names).toHaveLength(12)
    expect(names).not.toContain('clawops_gateway_restart')
    await c.close()
  })

  it('answers a read about this host, and records the caller with it', async () => {
    const c = await client(await serve(fakeTailscaled().deps))
    const r = await c.callTool({ name: 'clawops_stacks_list', arguments: {} })
    expect(r.isError).toBeFalsy()
    expect(JSON.parse(textOf(r))).toEqual({ stacks: [{ name: 'eu', provider: 'aws', isDefault: true, hostAgent: true }] })
    await c.close()
    const line = audit().find((e) => e['tool'] === 'clawops_stacks_list')
    expect(line).toMatchObject({ result: 'ok', peer: { name: 'us-gw.tail1234.ts.net', stableId: 'nUS', tags: [TAG] } })
  })

  it('refuses a read naming another stack, and records why', async () => {
    const c = await client(await serve(fakeTailscaled().deps))
    const r = await c.callTool({ name: 'clawops_status', arguments: { stackName: 'us' } })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toMatch(/manages only stack "eu"/)
    await c.close()
    expect(audit().find((e) => e['tool'] === 'clawops_status')).toMatchObject({
      result: 'error', peer: { stableId: 'nUS' }, reason: expect.stringMatching(/manages only stack "eu"/),
    })
  })

  it('refuses a destructive tool, which a peer is never offered', async () => {
    const c = await client(await serve(fakeTailscaled().deps))
    const r = await c.callTool({ name: 'clawops_gateway_restart', arguments: { stackName: 'eu' } }).catch((e: Error) => ({ isError: true, content: [{ type: 'text', text: e.message }] }))
    expect(r.isError).toBe(true)
    expect(textOf(r as never)).toMatch(/clawops_gateway_restart/)
    await c.close()
    expect(existsSync(path.join(home, 'handoffs.jsonl'))).toBe(false)
  })

  it('checks the caller on every request, so a peer untagged mid-session is refused at once', async () => {
    const { deps } = fakeTailscaled()
    const c = await client(await serve(deps))
    expect((await c.callTool({ name: 'clawops_stacks_list', arguments: {} })).isError).toBeFalsy()
    deps.who = { kind: 'node', node: { stableId: 'nUS', name: 'us-gw.tail1234.ts.net', tags: [] } }
    await expect(c.callTool({ name: 'clawops_stacks_list', arguments: {} })).rejects.toThrow(/does not carry tag:clawops-agent/)
    await c.close()
  })

  it('asks tailscaled about the exact address and port the connection came from', async () => {
    const { deps, lookups } = fakeTailscaled()
    const url = await serve(deps)
    const localPort = 40_000 + Math.floor(Math.random() * 20_000)
    const r = await post(url, INIT, localPort)
    expect(r.status).toBe(200)
    expect(lookups).toEqual([{ address: '127.0.0.1', port: localPort }])
  })

  it('refuses a stranger with 403 before reading the request, and records the refusal', async () => {
    const url = await serve(fakeTailscaled({ kind: 'none' }).deps)
    const r = await post(url, INIT)
    expect(r.status).toBe(403)
    expect(JSON.parse(r.body).error.message).toMatch(/is not a tailnet node/)
    expect(audit()).toEqual([expect.objectContaining({ tool: 'peer_listener', result: 'error', reason: expect.stringMatching(/not a tailnet node/), args: { remote: expect.stringMatching(/^127\.0\.0\.1:\d+$/) } })])
  })

  it('records the node that was refused, where whois named one', async () => {
    const url = await serve(fakeTailscaled({ kind: 'node', node: { stableId: 'nCI', name: 'ci', tags: ['tag:ci'] } }).deps)
    expect((await post(url, INIT)).status).toBe(403)
    expect(audit()[0]).toMatchObject({ tool: 'peer_listener', peer: { name: 'ci', stableId: 'nCI', tags: ['tag:ci'] } })
  })

  it('refuses lookups beyond the limit in flight', async () => {
    let release!: () => void
    const held = new Promise<void>((r) => { release = r })
    const deps: PeerAuthDeps = {
      async whois() { await held; return PEER },
      async self() { return RUNNING },
    }
    const url = await serve(deps, { maxLookups: 1 })
    const first = post(url, INIT)
    await new Promise((r) => setTimeout(r, 50))
    const second = await post(url, INIT)
    expect(second.status).toBe(503)
    expect(JSON.parse(second.body).error.message).toMatch(/1 caller lookups are already in flight/)
    release()
    expect((await first).status).toBe(200)
  })

  it('answers POST only', async () => {
    const url = await serve(fakeTailscaled().deps)
    const status = await new Promise<number>((resolve, reject) => {
      request(url, { method: 'GET' }, (res) => { res.resume(); resolve(res.statusCode ?? 0) }).on('error', reject).end()
    })
    expect(status).toBe(405)
  })

  it('ends a connection at the cap, however it is being used', async () => {
    const url = new URL(await serve(fakeTailscaled().deps, { capMs: 300 }))
    const started = Date.now()
    const closed = await new Promise<number>((resolve) => {
      const s = netConnect(Number(url.port), url.hostname, () => {
        // A request that never finishes: the headers, then nothing.
        s.write('POST / HTTP/1.1\r\nhost: x\r\ncontent-type: application/json\r\ncontent-length: 1000\r\n\r\n{')
      })
      s.on('close', () => resolve(Date.now() - started))
      s.on('error', () => {})
    })
    expect(closed).toBeGreaterThanOrEqual(250)
    expect(closed).toBeLessThan(2_000)
  })
})

describe('where the peer listener listens', () => {
  it('on the tailnet addresses in kernel mode, on loopback in userspace mode, nowhere off the tailnet', () => {
    expect(peerListenAddresses({ state: 'Running', ips: ['100.64.0.2', 'fd7a:115c:a1e0::2'], tun: true })).toEqual(['100.64.0.2', 'fd7a:115c:a1e0::2'])
    expect(peerListenAddresses({ state: 'Running', ips: ['100.64.0.2'], tun: false })).toEqual(['127.0.0.1'])
    expect(peerListenAddresses({ state: 'Starting', ips: ['100.64.0.2'], tun: true })).toBeUndefined()
    expect(peerListenAddresses({ state: 'Running', ips: [], tun: true })).toBeUndefined()
  })

  it('waits for the tailnet, then listens', async () => {
    const { deps } = fakeTailscaled(PEER, { ok: true, self: { state: 'NeedsLogin', ips: [], tun: false } })
    const lines: string[] = []
    let polls = 0
    const self = deps.self
    deps.self = async () => {
      if (++polls === 3) deps.me = { ok: true, self: { state: 'Running', stableId: SELF_ID, ips: ['100.64.0.2'], tun: false } }
      return self()
    }
    listener = await startPeerListener(TAG, () => new McpServer({ name: 'clawops', version: 'test' }), { deps, pollMs: 5, port: 0, log: (l) => lines.push(l) })
    expect(listener?.addresses).toEqual(['127.0.0.1'])
    // Said once while waiting, not once per poll.
    expect(lines.filter((l) => /waiting for the tailnet: tailscaled reports NeedsLogin/.test(l))).toHaveLength(1)
    expect(lines.at(-1)).toMatch(/peer listener on 127\.0\.0\.1 port \d+, serving callers tagged tag:clawops-agent/)
  })

  it('stops waiting when told to', async () => {
    const ac = new AbortController()
    const { deps } = fakeTailscaled(PEER, { ok: false, reason: 'tailscaled did not answer' })
    const started = startPeerListener(TAG, () => new McpServer({ name: 'clawops', version: 'test' }), { deps, pollMs: 5, port: 0, signal: ac.signal, log: () => {} })
    ac.abort()
    expect(await started).toBeUndefined()
  })
})
