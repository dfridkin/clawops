// The peer listener: where a host agent answers other host agents — ADR 0015 §2 and §3.
//
// A second HTTP server beside the one the host's own gateway reaches. That one is on the Docker
// bridge and takes a bearer token. This one is on the tailnet and takes no token: the credential
// is the caller's tailnet identity, which tailscaled reports for the exact `ip:port` the
// connection came from (SP-14).
//
// On every request, not every connection, it asks tailscaled who is calling and answers only a
// tailnet node that carries the tag it serves and is not this host. The bind address and ufw
// keep most strangers out, but Linux accepts a packet for the tailnet address on any interface
// (SP-14 finding 4), so the whois check is the boundary.
//
// It serves only the read tools, whatever the host's own agent was allowed. Each request gets a
// server of its own with no session, so nothing one caller set up is reachable by the next.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import process from 'node:process'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { auditPeerRefusal, type PeerCaller } from '../mcp/audit.js'
import { PEER_PORT } from './peer-firewall.js'
import { whois, selfStatus, type WhoisResult, type SelfResult } from './tailscaled.js'

/**
 * How long a connection may live. A revoked peer's open TCP connection keeps working while the
 * two nodes stay peers (SP-15 finding 3). The per-request check covers keep-alive; this bounds a
 * request that is already running.
 */
export const PEER_CONNECTION_CAP_MS = 60_000

/**
 * Lookups in flight at once. A miss holds a handler ~0.4 s inside tailscaled (SP-14 finding 5),
 * so strangers could otherwise pile them up; a hit takes about a millisecond.
 */
export const MAX_PEER_LOOKUPS = 4

/** The largest request body read. A read tool's arguments are a few hundred bytes. */
const MAX_BODY_BYTES = 256 * 1024

export interface PeerAuthDeps {
  whois: (address: string, port: number, signal?: AbortSignal) => Promise<WhoisResult>
  self: (signal?: AbortSignal) => Promise<SelfResult>
}

const tailscaledDeps: PeerAuthDeps = { whois, self: selfStatus }

export type PeerAuth =
  | { ok: true; caller: PeerCaller }
  | { ok: false; status: number; reason: string; caller?: PeerCaller }

/**
 * Whether the node at `address:port` may read this host: a tailnet node, not this host, carrying
 * the tag this host serves. Tags only: names and Hostinfo are chosen by the peer, and Headscale
 * reports the creating user even for a tagged node (SP-15 finding 4).
 */
export async function authorizePeer(serves: string, address: string, port: number, deps: PeerAuthDeps = tailscaledDeps, signal?: AbortSignal): Promise<PeerAuth> {
  const [who, me] = await Promise.all([deps.whois(address, port, signal), deps.self(signal)])
  if (who.kind === 'none') {
    return { ok: false, status: 403, reason: `Refused: ${address}:${port} is not a tailnet node. Peers are reached only over the tailnet.` }
  }
  if (who.kind === 'error') return { ok: false, status: 503, reason: `Refused: ${who.reason}` }
  const caller: PeerCaller = { name: who.node.name, stableId: who.node.stableId, tags: who.node.tags }
  // Read on every request: a node that re-registers gets a new StableID, and a cached one would
  // let a local process through as a peer.
  if (!me.ok || me.self.stableId === undefined) {
    return {
      ok: false,
      status: 503,
      reason: `Refused: this host's own tailnet identity could not be read, so a call from this host could not be told apart. ${me.ok ? 'tailscaled reported no StableID.' : me.reason}`,
      caller,
    }
  }
  // A process on this host that connects to its own tailnet address is named as this host, tags
  // and all (SP-14 finding 4).
  if (caller.stableId === me.self.stableId) {
    return { ok: false, status: 403, reason: 'Refused: the caller is this host. A host agent answers for itself without being its own peer.', caller }
  }
  if (!caller.tags.includes(serves)) {
    const tags = caller.tags.length > 0 ? caller.tags.join(', ') : 'none'
    return { ok: false, status: 403, reason: `Refused: ${caller.name || caller.stableId} does not carry ${serves} (its tags: ${tags}).`, caller }
  }
  return { ok: true, caller }
}

/** `::ffff:100.64.0.1` as `100.64.0.1`: tailscaled knows the node by its IPv4 address. */
export function plainAddress(address: string): string {
  return address.startsWith('::ffff:') && address.includes('.') ? address.slice(7) : address
}

export interface PeerHandlerOpts {
  /** The tag a caller must carry, from agent.json's `fleet.serves`. */
  serves: string
  /** A server holding only the read tools, built for one caller's request. */
  makeServer: (caller: PeerCaller) => McpServer
  deps?: PeerAuthDeps
  maxLookups?: number
}

function refuse(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) return
  res.writeHead(status, { 'content-type': 'application/json', connection: 'close' })
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message }, id: null }))
}

function readBody(req: IncomingMessage): Promise<{ ok: true; body: unknown } | { ok: false; status: number; reason: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    const finish = (r: Awaited<ReturnType<typeof readBody>>) => { if (!done) { done = true; resolve(r) } }
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY_BYTES) { finish({ ok: false, status: 413, reason: 'Refused: the request is too large.' }); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        finish({ ok: true, body: JSON.parse(Buffer.concat(chunks).toString('utf-8')) })
      } catch {
        finish({ ok: false, status: 400, reason: 'Refused: the request is not JSON.' })
      }
    })
    req.on('error', () => finish({ ok: false, status: 400, reason: 'Refused: the request could not be read.' }))
  })
}

/** The request handler, apart from the socket, so tests can drive it on loopback. */
export function createPeerHandler(opts: PeerHandlerOpts): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const max = opts.maxLookups ?? MAX_PEER_LOOKUPS
  let inFlight = 0
  return async (req, res) => {
    const address = plainAddress(req.socket.remoteAddress ?? '')
    const port = req.socket.remotePort ?? 0
    const remote = address.includes(':') ? `[${address}]:${port}` : `${address}:${port}`

    if (inFlight >= max) {
      const reason = `Refused: ${max} caller lookups are already in flight. Try again shortly.`
      auditPeerRefusal(remote, reason)
      refuse(res, 503, reason)
      return
    }
    inFlight++
    let auth: PeerAuth
    try {
      auth = await authorizePeer(opts.serves, address, port, opts.deps)
    } finally {
      inFlight--
    }
    if (!auth.ok) {
      auditPeerRefusal(remote, auth.reason, auth.caller)
      refuse(res, auth.status, auth.reason)
      return
    }

    // Stateless and JSON-only: each request stands alone, and none holds a stream open.
    if (req.method !== 'POST') {
      const reason = `Refused: the peer listener answers POST only, not ${req.method ?? 'no method'}.`
      auditPeerRefusal(remote, reason, auth.caller)
      res.setHeader('allow', 'POST')
      refuse(res, 405, reason)
      return
    }
    const body = await readBody(req)
    if (!body.ok) {
      auditPeerRefusal(remote, body.reason, auth.caller)
      refuse(res, body.status, body.reason)
      return
    }

    const server = opts.makeServer(auth.caller)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, body.body)
  }
}

export interface PeerListener {
  addresses: string[]
  port: number
  close: () => Promise<void>
}

/** Listen on each address, with every connection cut at the cap. At least one must bind. */
export async function listenPeers(
  addresses: readonly string[],
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  opts: { port?: number; capMs?: number; log?: (line: string) => void } = {},
): Promise<PeerListener> {
  const port = opts.port ?? PEER_PORT
  const cap = opts.capMs ?? PEER_CONNECTION_CAP_MS
  const log = opts.log ?? ((line: string) => process.stderr.write(`[clawops] ${line}\n`))
  const servers: Server[] = []
  const bound: string[] = []
  const sockets = new Set<Socket>()
  for (const address of addresses) {
    const server = createServer((req, res) => {
      handler(req, res).catch((err: unknown) => {
        log(`peer listener: ${err instanceof Error ? err.message : String(err)}`)
        refuse(res, 500, 'The peer listener failed on this request.')
      })
    })
    server.on('connection', (socket: Socket) => {
      sockets.add(socket)
      const timer = setTimeout(() => socket.destroy(), cap)
      timer.unref()
      socket.once('close', () => { clearTimeout(timer); sockets.delete(socket) })
    })
    server.headersTimeout = Math.min(10_000, cap)
    server.requestTimeout = cap
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, address, () => { server.off('error', reject); resolve() })
      })
      servers.push(server)
      bound.push(address)
    } catch (err) {
      log(`peer listener: could not listen on ${address}:${port}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (bound.length === 0) throw new Error(`The peer listener could not listen on ${addresses.join(', ') || 'any address'}, port ${port}.`)
  // The port bound, which differs from the one asked for only when that was 0 (tests).
  const addr = servers[0]!.address()
  return {
    addresses: bound,
    port: typeof addr === 'object' && addr ? addr.port : port,
    close: async () => {
      for (const s of sockets) s.destroy()
      await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))))
    },
  }
}

/**
 * Where to listen: the tailnet addresses in kernel mode; loopback in userspace mode, where
 * tailscaled's netstack hands inbound tailnet TCP to 127.0.0.1 (SP-14 finding 2).
 */
export function peerListenAddresses(self: { state: string; ips: string[]; tun: boolean }): string[] | undefined {
  if (self.state !== 'Running') return undefined
  if (!self.tun) return ['127.0.0.1']
  return self.ips.length > 0 ? [...self.ips] : undefined
}

/**
 * Start the peer listener once the host is on the tailnet, and keep trying until it is.
 *
 * At boot the agent can start before tailscaled has an address, and there is nothing to bind
 * until it does. It never throws: the host's own listener keeps serving its gateway whatever
 * the tailnet is doing, and `clawops fleet status` reports a member whose listener is down.
 */
export async function startPeerListener(
  serves: string,
  makeServer: (caller: PeerCaller) => McpServer,
  opts: { signal?: AbortSignal; pollMs?: number; port?: number; deps?: PeerAuthDeps; log?: (line: string) => void } = {},
): Promise<PeerListener | undefined> {
  const deps = opts.deps ?? tailscaledDeps
  const log = opts.log ?? ((line: string) => process.stderr.write(`[clawops] ${line}\n`))
  const handler = createPeerHandler({ serves, makeServer, deps })
  let said = ''
  while (!opts.signal?.aborted) {
    const me = await deps.self(opts.signal)
    const addresses = me.ok ? peerListenAddresses(me.self) : undefined
    if (addresses) {
      try {
        const listener = await listenPeers(addresses, handler, { port: opts.port, log })
        log(`peer listener on ${listener.addresses.map((a) => (a.includes(':') ? `[${a}]` : a)).join(', ')} port ${listener.port}, serving callers tagged ${serves}`)
        return listener
      } catch (err) {
        const line = err instanceof Error ? err.message : String(err)
        if (line !== said) { log(line); said = line }
      }
    } else {
      const line = `peer listener waiting for the tailnet: ${me.ok ? `tailscaled reports ${me.self.state}` : me.reason}`
      if (line !== said) { log(line); said = line }
    }
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 5_000).unref())
  }
  return undefined
}
