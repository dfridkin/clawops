// The LocalAPI client, against an HTTP server on a real unix socket that answers as tailscaled
// 1.88 does (SP-14). What it asks, and how it reads each answer, including the failures.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { whois, selfStatus } from '../../src/hostagent/tailscaled.js'

let dir: string
let server: Server | undefined
let seen: IncomingMessage[]
let answer: (req: IncomingMessage) => { status: number; body: string }
const saved = process.env['CLAWOPS_TAILSCALED_SOCKET']

/** tailscale whois --json, from SP-14 finding 1. */
const WHOIS = JSON.stringify({
  Node: {
    ID: 1, StableID: 'nStable1', Name: 'us-gw.tail1234.ts.net.', User: 1, Tags: ['tag:clawops-agent'],
    Addresses: ['100.64.0.1/32'], ComputedName: 'us-gw', Hostinfo: { Hostname: 'lies' },
  },
  UserProfile: { ID: 1, LoginName: 'tagged-devices' },
  CapMap: null,
})

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'clawops-ts-'))
  const socket = path.join(dir, 'tailscaled.sock')
  process.env['CLAWOPS_TAILSCALED_SOCKET'] = socket
  seen = []
  answer = () => ({ status: 200, body: WHOIS })
  server = createServer((req, res) => {
    seen.push(req)
    const a = answer(req)
    res.writeHead(a.status, { 'content-type': 'application/json' })
    res.end(a.body)
  })
  await new Promise<void>((r) => server!.listen(socket, r))
})

afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
  server = undefined
  if (saved === undefined) delete process.env['CLAWOPS_TAILSCALED_SOCKET']
  else process.env['CLAWOPS_TAILSCALED_SOCKET'] = saved
  rmSync(dir, { recursive: true, force: true })
})

describe('whois', () => {
  it('asks for the exact ip:port, with the host name tailscaled expects', async () => {
    await whois('127.0.0.1', 53888)
    expect(seen[0]!.url).toBe('/localapi/v0/whois?addr=127.0.0.1%3A53888')
    expect(seen[0]!.method).toBe('GET')
    expect(seen[0]!.headers.host).toBe('local-tailscaled.sock')
  })

  it('brackets an IPv6 address', async () => {
    await whois('fd7a:115c:a1e0::1', 41000)
    expect(decodeURIComponent(seen[0]!.url!.split('addr=')[1]!)).toBe('[fd7a:115c:a1e0::1]:41000')
  })

  it('reads the node\'s StableID, name and tags, and nothing it chose itself', async () => {
    expect(await whois('100.64.0.1', 1)).toEqual({ kind: 'node', node: { stableId: 'nStable1', name: 'us-gw.tail1234.ts.net', tags: ['tag:clawops-agent'] } })
  })

  it('reads an untagged node as having no tags', async () => {
    answer = () => ({ status: 200, body: JSON.stringify({ Node: { StableID: 'n2', Name: 'laptop.', Tags: null } }) })
    expect(await whois('100.64.0.3', 1)).toEqual({ kind: 'node', node: { stableId: 'n2', name: 'laptop', tags: [] } })
  })

  it('reads 404 as no tailnet node', async () => {
    answer = () => ({ status: 404, body: 'no match for IP:port\n' })
    expect(await whois('192.168.1.7', 1)).toEqual({ kind: 'none' })
  })

  it('reads anything else as an error, never as a node', async () => {
    answer = () => ({ status: 500, body: '' })
    expect(await whois('100.64.0.1', 1)).toMatchObject({ kind: 'error', reason: expect.stringMatching(/HTTP 500/) })
    answer = () => ({ status: 200, body: 'not json' })
    expect(await whois('100.64.0.1', 1)).toMatchObject({ kind: 'error' })
    answer = () => ({ status: 200, body: JSON.stringify({ Node: { Name: 'x', Tags: ['tag:clawops-agent'] } }) })
    expect(await whois('100.64.0.1', 1)).toMatchObject({ kind: 'error', reason: expect.stringMatching(/without a node/) })
  })

  it('reads a socket nobody answers on as an error', async () => {
    process.env['CLAWOPS_TAILSCALED_SOCKET'] = path.join(dir, 'missing.sock')
    expect(await whois('100.64.0.1', 1)).toMatchObject({ kind: 'error', reason: expect.stringMatching(/could not be asked.*ENOENT/) })
  })
})

describe('selfStatus', () => {
  it('reads this node\'s StableID, addresses and networking mode', async () => {
    answer = () => ({ status: 200, body: JSON.stringify({ BackendState: 'Running', TUN: true, Self: { ID: 'nSelf', TailscaleIPs: ['100.64.0.2', 'fd7a:115c:a1e0::2'], Tags: ['tag:clawops-agent'] } }) })
    expect(await selfStatus()).toEqual({ ok: true, self: { state: 'Running', stableId: 'nSelf', ips: ['100.64.0.2', 'fd7a:115c:a1e0::2'], tun: true } })
    expect(seen[0]!.url).toBe('/localapi/v0/status?peers=false')
  })

  it('reads userspace networking from TUN: false', async () => {
    answer = () => ({ status: 200, body: JSON.stringify({ BackendState: 'Running', TUN: false, Self: { ID: 'nSelf', TailscaleIPs: ['100.64.0.2'] } }) })
    expect(await selfStatus()).toMatchObject({ ok: true, self: { tun: false } })
  })

  it('reads a node not yet logged in, which has no StableID', async () => {
    answer = () => ({ status: 200, body: JSON.stringify({ BackendState: 'NeedsLogin', TUN: true, Self: { ID: '', TailscaleIPs: null } }) })
    expect(await selfStatus()).toEqual({ ok: true, self: { state: 'NeedsLogin', ips: [], tun: true } })
  })

  it('says why when tailscaled cannot be read', async () => {
    answer = () => ({ status: 403, body: '' })
    expect(await selfStatus()).toEqual({ ok: false, reason: expect.stringMatching(/HTTP 403/) })
  })
})
