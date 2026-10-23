// The peer client: finding a peer on the tailnet, asking it with one retry, and running the query
// in a child process. The child is real here, started with this user's own uid (the one change
// of uid a test can make without root); the e2e run covers the drop to clawops-peer.

import { describe, it, expect, afterEach, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {
  callPeer, findPeer, namesPeer, peerUserIds, postJson, runPeerCall, type PeerClientDeps, type PostAnswer,
} from '../../src/hostagent/peer-client.js'
import type { TailnetPeer } from '../../src/hostagent/tailscaled.js'

const EU: TailnetPeer = { dnsName: 'eu-gw.tail1234.ts.net', ips: ['fd7a:115c:a1e0::5', '100.64.0.5'], online: true }
const OTHER: TailnetPeer = { dnsName: 'laptop.tail1234.ts.net', ips: ['100.64.0.9'], online: true }
const listed = { ok: true as const, peers: [OTHER, EU] }
const RESULT = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'running' }] } })

describe('finding the peer', () => {
  it('matches the full MagicDNS name or its first label, in any case, and nothing the peer only calls itself', () => {
    expect(namesPeer('eu-gw', EU)).toBe(true)
    expect(namesPeer('EU-GW.tail1234.ts.net.', EU)).toBe(true)
    expect(namesPeer('eu', EU)).toBe(false)
    expect(namesPeer('tail1234', EU)).toBe(false)
  })

  it('reaches it on IPv4 where it has one', () => {
    expect(findPeer('eu-gw', listed)).toEqual({ ok: true, peer: EU, address: '100.64.0.5' })
    expect(findPeer('eu-gw', { ok: true, peers: [{ ...EU, ips: ['fd7a:115c:a1e0::5'] }] })).toMatchObject({ address: 'fd7a:115c:a1e0::5' })
  })

  it('refuses a name not on the tailnet, a short name two nodes share, and a node with no address', () => {
    expect(findPeer('ap-gw', listed)).toEqual({ ok: false, reason: 'No node named "ap-gw" is on this host\'s tailnet.' })
    const twin = { ...EU, dnsName: 'eu-gw.other.ts.net' }
    expect(findPeer('eu-gw', { ok: true, peers: [EU, twin] })).toMatchObject({ ok: false, reason: expect.stringMatching(/names 2 nodes.*full MagicDNS name/) })
    expect(findPeer('eu-gw', { ok: true, peers: [{ ...EU, ips: [] }] })).toMatchObject({ ok: false, reason: expect.stringMatching(/no tailnet address/) })
    expect(findPeer('eu-gw', { ok: false, reason: 'tailscaled did not answer' })).toEqual({ ok: false, reason: 'tailscaled did not answer' })
  })
})

function deps(answers: Array<PostAnswer | Error>, over: Partial<PeerClientDeps> = {}) {
  const posts: Array<{ url: string; body: unknown; timeoutMs: number }> = []
  const d: PeerClientDeps = {
    peers: async () => listed,
    post: async (url, body, timeoutMs) => {
      posts.push({ url, body: JSON.parse(body), timeoutMs })
      const a = answers.shift() ?? new Error('no more answers')
      if (a instanceof Error) throw a
      return a
    },
    ...over,
  }
  return { d, posts }
}

describe('asking the peer', () => {
  it('posts one tools/call to its listener', async () => {
    const { d, posts } = deps([{ status: 200, body: RESULT }])
    const r = await callPeer({ node: 'eu-gw', tool: 'clawops_gateway_status', args: { stackName: 'eu' } }, d)
    expect(r).toEqual({ ok: true, answeredBy: 'eu-gw.tail1234.ts.net', result: { content: [{ type: 'text', text: 'running' }] } })
    expect(posts).toEqual([{
      url: 'http://100.64.0.5:18800/',
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'clawops_gateway_status', arguments: { stackName: 'eu' } } },
      timeoutMs: 7_000,
    }])
  })

  it('brackets an IPv6 address in the URL', async () => {
    const { d, posts } = deps([{ status: 200, body: RESULT }], { peers: async () => ({ ok: true, peers: [{ ...EU, ips: ['fd7a:115c:a1e0::5'] }] }) })
    await callPeer({ node: 'eu-gw', tool: 't', args: {} }, d)
    expect(posts[0]!.url).toBe('http://[fd7a:115c:a1e0::5]:18800/')
  })

  it('tries once more when the connection fails or stalls', async () => {
    const { d, posts } = deps([new Error('no answer within 7 s'), { status: 200, body: RESULT }])
    expect((await callPeer({ node: 'eu-gw', tool: 't', args: {} }, d)).ok).toBe(true)
    expect(posts).toHaveLength(2)
  })

  it('gives up after the second attempt, and says whether tailscaled sees the peer', async () => {
    const { d, posts } = deps([new Error('ECONNREFUSED'), new Error('no answer within 7 s')], { peers: async () => ({ ok: true, peers: [{ ...EU, online: false }] }) })
    expect(await callPeer({ node: 'eu-gw', tool: 't', args: {} }, d)).toEqual({
      ok: false, reason: 'eu-gw.tail1234.ts.net did not answer after 2 attempts: no answer within 7 s (tailscaled reports it offline)',
    })
    expect(posts).toHaveLength(2)
  })

  it('does not ask again after an answer, even a refusal', async () => {
    const refused = JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Refused: us-gw does not carry tag:clawops-agent (its tags: none).' }, id: null })
    const { d, posts } = deps([{ status: 403, body: refused }, { status: 200, body: RESULT }])
    expect(await callPeer({ node: 'eu-gw', tool: 't', args: {} }, d)).toEqual({
      ok: false, reason: 'eu-gw.tail1234.ts.net answered HTTP 403: Refused: us-gw does not carry tag:clawops-agent (its tags: none).',
    })
    expect(posts).toHaveLength(1)
  })

  it('reads a JSON-RPC error, and an answer that is no tool result, as no answer', async () => {
    const err = JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Tool clawops_x not found' } })
    expect(await callPeer({ node: 'eu-gw', tool: 't', args: {} }, deps([{ status: 200, body: err }]).d)).toMatchObject({ ok: false, reason: expect.stringMatching(/answered: Tool clawops_x not found/) })
    expect(await callPeer({ node: 'eu-gw', tool: 't', args: {} }, deps([{ status: 200, body: '{"result":{}}' }]).d)).toMatchObject({ ok: false, reason: expect.stringMatching(/not a tool result/) })
  })

  it('asks nothing when the peer is not found', async () => {
    const { d, posts } = deps([])
    expect((await callPeer({ node: 'ap-gw', tool: 't', args: {} }, d)).ok).toBe(false)
    expect(posts).toEqual([])
  })
})

describe('postJson', () => {
  let server: Server | undefined
  afterEach(async () => { await new Promise<void>((r) => (server ? server.close(() => r()) : r())); server = undefined })

  async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
    server = createServer(handler)
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
    const a = server.address()
    return `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}/`
  }

  it('returns the status and body', async () => {
    const url = await listen((req, res) => { req.resume(); res.writeHead(200).end(RESULT) })
    expect(await postJson(url, '{}', 1000)).toEqual({ status: 200, body: RESULT })
  })

  it('gives up on a peer that accepts and never answers', async () => {
    const url = await listen(() => { /* holds the request */ })
    const started = Date.now()
    await expect(postJson(url, '{}', 200)).rejects.toThrow(/no answer within 0.2 s/)
    expect(Date.now() - started).toBeLessThan(2_000)
    server?.closeAllConnections()
  })

  it('gives up on a peer that answers a byte at a time, however long it keeps the connection busy', async () => {
    const url = await listen((req, res) => {
      req.resume()
      res.writeHead(200)
      const drip = setInterval(() => res.write(' '), 50)
      res.on('close', () => clearInterval(drip))
    })
    const started = Date.now()
    await expect(postJson(url, '{}', 300)).rejects.toThrow(/no answer within 0.3 s/)
    expect(Date.now() - started).toBeLessThan(1_500)
    server?.closeAllConnections()
  })

  it('refuses an answer too large to be a tool result', async () => {
    const url = await listen((req, res) => { req.resume(); res.writeHead(200).end('x'.repeat(300 * 1024)) })
    await expect(postJson(url, '{}', 2000)).rejects.toThrow(/too large/)
  })
})

describe('the child process', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'clawops-peer-child-'))
  afterEach(() => { delete process.env['CLAWOPS_TAILSCALED_SOCKET'] })
  const me = { uid: process.getuid!(), gid: process.getgid!() }
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  function script(name: string, body: string): string {
    const f = path.join(dir, name)
    writeFileSync(f, body)
    return f
  }

  it('hands the request over on stdin and reads the answer from stdout, with nothing of the host agent\'s environment', async () => {
    process.env['CLAWOPS_MCP_TOKEN_FOR_TEST'] = 'secret'
    process.env['CLAWOPS_TAILSCALED_SOCKET'] = '/sock/tailscaled.sock'
    const entry = script('echo.mjs', `
      if (process.argv[2] !== '--peer-call') process.exit(9)
      let s = ''; for await (const c of process.stdin) s += c
      const req = JSON.parse(s)
      console.log(JSON.stringify({ ok: true, answeredBy: req.node, result: { content: [{ type: 'text', text: JSON.stringify({ env: Object.keys(process.env).filter((k) => !k.startsWith('__CF_')).sort(), cwd: process.cwd(), tool: req.tool }) }] } }))
    `)
    const r = await runPeerCall({ node: 'eu-gw', tool: 'clawops_status', args: {} }, 998, { entry, ids: me })
    delete process.env['CLAWOPS_MCP_TOKEN_FOR_TEST']
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const seen = JSON.parse((r.result.content[0] as { text: string }).text) as { env: string[]; cwd: string; tool: string }
    expect(seen).toEqual({ env: ['CLAWOPS_TAILSCALED_SOCKET', 'PATH'], cwd: '/', tool: 'clawops_status' })
  })

  it('reports a child that fails without an answer', async () => {
    const entry = script('fail.mjs', "process.stderr.write('Error: EACCES: permission denied\\n'); process.exit(3)")
    expect(await runPeerCall({ node: 'eu-gw', tool: 't', args: {} }, 998, { entry, ids: me })).toEqual({
      ok: false, reason: 'The peer query failed: it exited 3: Error: EACCES: permission denied.',
    })
  })

  it('refuses when clawops-peer is not the user install created', async () => {
    expect(await runPeerCall({ node: 'eu-gw', tool: 't', args: {} }, 998, { entry: '/nonexistent', ids: undefined })).toMatchObject({ ok: false })
    const passwd = 'root:x:0:0::/root:/bin/bash\nclawops-peer:x:998:997::/nonexistent:/usr/sbin/nologin\n'
    expect(peerUserIds(998, passwd)).toEqual({ uid: 998, gid: 997 })
    expect(peerUserIds(999, passwd)).toBeUndefined()
    expect(peerUserIds(0, passwd)).toBeUndefined()
  })
})
