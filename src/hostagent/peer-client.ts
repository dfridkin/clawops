// Querying a peer: the calling side of ADR 0015 §4 and §5.
//
// A peer query leaves this host as `clawops-peer`, the one uid the firewall table lets reach port
// 18800 on the tailnet (peer-firewall.ts). The host agent runs as root, as every `--network host`
// container does, so it cannot send the query itself: it starts a child process with that uid,
// which finds the peer, asks it, and prints the answer. Nothing else runs in the child, and its
// environment holds nothing of the host agent's: no token, no config.
//
// The peer is found by the MagicDNS name the operator gave `--peer`, in tailscaled's own list of
// peers rather than through DNS: a host hardened with `--accept-dns=false` resolves no tailnet
// names, and the control server, not the peer, keeps those names unique.

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { request } from 'node:http'
import process from 'node:process'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { PEER_PORT, PEER_USER } from './peer-firewall.js'
import { tailnetPeers, type PeersResult, type TailnetPeer } from './tailscaled.js'

/**
 * One attempt's limit. The first connection after tailscaled restarts took over 4 s in SP-16, and
 * one with no direct path yet stalls until it has one (SP-14), so there is a second attempt.
 */
export const PEER_ATTEMPT_TIMEOUT_MS = 7_000
export const PEER_ATTEMPTS = 2

/** The largest answer read from a peer. A peer caps its own at 8 KB (R14); this is well over. */
const MAX_ANSWER_BYTES = 256 * 1024

export interface PeerCallRequest {
  /** The `--peer` name: a MagicDNS name, short or full. */
  node: string
  tool: string
  args: Record<string, unknown>
}

export type PeerAnswer =
  | { ok: true; answeredBy: string; result: CallToolResult }
  | { ok: false; reason: string }

/** Whether a `--peer` name is this peer's MagicDNS name, full or its first label. */
export function namesPeer(node: string, peer: TailnetPeer): boolean {
  const n = node.toLowerCase().replace(/\.$/, '')
  const dns = peer.dnsName.toLowerCase()
  return n === dns || n === dns.split('.')[0]
}

/** The peer a `--peer` name means, and the address to reach it on: IPv4 where it has one. */
export function findPeer(node: string, listed: PeersResult): { ok: true; peer: TailnetPeer; address: string } | { ok: false; reason: string } {
  if (!listed.ok) return { ok: false, reason: listed.reason }
  const matches = listed.peers.filter((p) => namesPeer(node, p))
  if (matches.length === 0) return { ok: false, reason: `No node named "${node}" is on this host's tailnet.` }
  if (matches.length > 1) {
    return { ok: false, reason: `"${node}" names ${matches.length} nodes on the tailnet (${matches.map((m) => m.dnsName).join(', ')}). Reinstall with its full MagicDNS name.` }
  }
  const peer = matches[0]!
  const address = peer.ips.find((ip) => !ip.includes(':')) ?? peer.ips[0]
  if (!address) return { ok: false, reason: `${peer.dnsName} has no tailnet address.` }
  return { ok: true, peer, address }
}

export interface PostAnswer { status: number; body: string }

/** One POST, with a deadline on the whole exchange. Rejects on a connection that fails or stalls. */
export function postJson(url: string, body: string, timeoutMs: number): Promise<PostAnswer> {
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      timeout: timeoutMs,
    }, (res) => {
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (c: Buffer) => {
        size += c.length
        if (size > MAX_ANSWER_BYTES) { req.destroy(new Error('the answer was too large')); return }
        chunks.push(c)
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }))
      res.on('error', reject)
    })
    const deadline = setTimeout(() => req.destroy(new Error(`no answer within ${timeoutMs / 1000} s`)), timeoutMs)
    req.on('close', () => clearTimeout(deadline))
    req.on('timeout', () => req.destroy(new Error(`no answer within ${timeoutMs / 1000} s`)))
    req.on('error', reject)
    req.end(body)
  })
}

export interface PeerClientDeps {
  peers: () => Promise<PeersResult>
  post: (url: string, body: string, timeoutMs: number) => Promise<PostAnswer>
  attemptTimeoutMs?: number
  attempts?: number
}

const realClientDeps: PeerClientDeps = { peers: () => tailnetPeers(), post: postJson }

/** What a peer's JSON-RPC answer says: the tool's result, or why there is none. */
function readAnswer(answeredBy: string, a: PostAnswer): PeerAnswer {
  let parsed: { result?: unknown; error?: { message?: unknown } } | undefined
  try { parsed = JSON.parse(a.body) as typeof parsed } catch { parsed = undefined }
  const message = typeof parsed?.error?.message === 'string' ? parsed.error.message : undefined
  if (a.status !== 200) return { ok: false, reason: `${answeredBy} answered HTTP ${a.status}${message ? `: ${message}` : '.'}` }
  if (message) return { ok: false, reason: `${answeredBy} answered: ${message}` }
  const result = parsed?.result as CallToolResult | undefined
  if (!result || !Array.isArray(result.content)) return { ok: false, reason: `${answeredBy} answered with something that is not a tool result.` }
  return { ok: true, answeredBy, result }
}

/**
 * Find the peer and ask it, with one retry when the connection fails or stalls. An answer, even
 * a refusal, is not retried: asking again would get the same one.
 */
export async function callPeer(req: PeerCallRequest, deps: PeerClientDeps = realClientDeps): Promise<PeerAnswer> {
  const found = findPeer(req.node, await deps.peers())
  if (!found.ok) return found
  const url = `http://${found.address.includes(':') ? `[${found.address}]` : found.address}:${PEER_PORT}/`
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: req.tool, arguments: req.args } })
  const attempts = deps.attempts ?? PEER_ATTEMPTS
  let last = ''
  for (let i = 0; i < attempts; i++) {
    try {
      return readAnswer(found.peer.dnsName, await deps.post(url, body, deps.attemptTimeoutMs ?? PEER_ATTEMPT_TIMEOUT_MS))
    } catch (err) {
      last = err instanceof Error ? err.message : String(err)
    }
  }
  return { ok: false, reason: `${found.peer.dnsName} did not answer after ${attempts} attempts: ${last}${found.peer.online ? '' : ' (tailscaled reports it offline)'}` }
}

/** The child's whole job, for `host-agent.mjs --peer-call`: a request on stdin, the answer on stdout. */
export async function peerCallMain(): Promise<void> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  let answer: PeerAnswer
  try {
    answer = await callPeer(JSON.parse(Buffer.concat(chunks).toString('utf-8')) as PeerCallRequest)
  } catch (err) {
    answer = { ok: false, reason: `The peer query could not run: ${err instanceof Error ? err.message : String(err)}` }
  }
  process.stdout.write(JSON.stringify(answer) + '\n')
}

/** clawops-peer's uid and gid, from /etc/passwd, or undefined when it is not there or not the uid install recorded. */
export function peerUserIds(uid: number, passwd = readPasswd()): { uid: number; gid: number } | undefined {
  for (const line of passwd.split('\n')) {
    const [name, , u, g] = line.split(':')
    if (name === PEER_USER && Number(u) === uid && Number.isInteger(Number(g))) return { uid, gid: Number(g) }
  }
  return undefined
}

function readPasswd(): string {
  try { return readFileSync('/etc/passwd', 'utf-8') } catch { return '' }
}

/**
 * Run one peer query in a child process as clawops-peer. The child is this same host-agent build,
 * started with `--peer-call`, so what it runs is exactly what the operator installed.
 */
export async function runPeerCall(req: PeerCallRequest, peerUid: number, opts: { entry?: string; ids?: { uid: number; gid: number } } = {}): Promise<PeerAnswer> {
  const ids = opts.ids ?? peerUserIds(peerUid)
  if (!ids) return { ok: false, reason: `There is no ${PEER_USER} user with uid ${peerUid}, which install created. Run \`clawops agent install\` again.` }
  const entry = opts.entry ?? process.argv[1]
  if (!entry) return { ok: false, reason: 'The host agent cannot find its own entry point to start a peer query.' }
  const limit = (PEER_ATTEMPT_TIMEOUT_MS * PEER_ATTEMPTS) + 5_000
  return new Promise((resolve) => {
    const env: Record<string, string> = { PATH: '/usr/bin:/bin' }
    if (process.env['CLAWOPS_TAILSCALED_SOCKET']) env['CLAWOPS_TAILSCALED_SOCKET'] = process.env['CLAWOPS_TAILSCALED_SOCKET']
    const child = spawn(process.execPath, [entry, '--peer-call'], { uid: ids.uid, gid: ids.gid, env, cwd: '/', stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), limit)
    child.stdout.on('data', (d: Buffer) => { out += d.toString() })
    child.stderr.on('data', (d: Buffer) => { err += d.toString() })
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, reason: `The peer query could not start: ${e.message}` }) })
    child.on('close', (code, sig) => {
      clearTimeout(timer)
      const last = out.trim().split('\n').at(-1) ?? ''
      try {
        resolve(JSON.parse(last) as PeerAnswer)
      } catch {
        const why = sig === 'SIGKILL' ? `it ran past ${limit / 1000} s` : `it exited ${code ?? sig}${err.trim() ? `: ${err.trim().split('\n')[0]}` : ''}`
        resolve({ ok: false, reason: `The peer query failed: ${why}.` })
      }
    })
    child.stdin.end(JSON.stringify(req))
  })
}
