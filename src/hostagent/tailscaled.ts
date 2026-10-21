// tailscaled's LocalAPI, as the peer listener asks it — ADR 0015 §2, measured in SP-14.
//
// Two questions, both read-only, over tailscaled's unix socket: who is at this `ip:port` (whois),
// and who is this host (status). tailscaled answers both to any local user and refuses writes
// (SP-14 finding 3), so nothing here holds a credential.
//
// Every failure is an answer the caller refuses on, never an exception: a peer whose identity
// could not be read is not a peer.

import { request } from 'node:http'
import process from 'node:process'

export const TAILSCALED_SOCKET = '/run/tailscale/tailscaled.sock'

/** The socket path, overridable for tests and for a tailscaled run with `--socket`. */
export function tailscaledSocket(): string {
  return process.env['CLAWOPS_TAILSCALED_SOCKET'] ?? TAILSCALED_SOCKET
}

/** A miss takes ~0.4 s inside tailscaled (SP-14 finding 5); this is well past it. */
const LOOKUP_TIMEOUT_MS = 3_000

/** The fields of a tailnet node a caller is judged on. Tags only for authorisation (SP-15 finding 4). */
export interface TailnetNode {
  stableId: string
  /** The MagicDNS name, for audit and messages. Chosen by the peer, so never authorised on. */
  name: string
  tags: string[]
}

export type WhoisResult =
  | { kind: 'node'; node: TailnetNode }
  | { kind: 'none' }
  | { kind: 'error'; reason: string }

export interface SelfStatus {
  state: string
  stableId?: string
  /** The node's tailnet addresses, v4 and v6. */
  ips: string[]
  /** False in userspace networking, where there is no tailnet interface to bind (SP-14 finding 2). */
  tun: boolean
}

export type SelfResult = { ok: true; self: SelfStatus } | { ok: false; reason: string }

interface Answer { status: number; body: string }

function get(pathAndQuery: string, signal?: AbortSignal): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: tailscaledSocket(),
        path: pathAndQuery,
        method: 'GET',
        // The name tailscale's own CLI sends; tailscaled checks it against DNS rebinding.
        headers: { host: 'local-tailscaled.sock' },
        timeout: LOOKUP_TIMEOUT_MS,
        signal,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }))
        res.on('error', reject)
      },
    )
    req.on('timeout', () => req.destroy(new Error(`tailscaled did not answer within ${LOOKUP_TIMEOUT_MS / 1000} s`)))
    req.on('error', reject)
    req.end()
  })
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/**
 * Who is at this exact `ip:port`, asked while the connection is open.
 *
 * The full `ip:port` it accepted, not only the IP: in userspace networking every caller arrives
 * from 127.0.0.1, and tailscaled tells them apart only by the port (SP-14 finding 2).
 */
export async function whois(address: string, port: number, signal?: AbortSignal): Promise<WhoisResult> {
  const addr = address.includes(':') ? `[${address}]:${port}` : `${address}:${port}`
  let answer: Answer
  try {
    answer = await get(`/localapi/v0/whois?addr=${encodeURIComponent(addr)}`, signal)
  } catch (err) {
    return { kind: 'error', reason: `tailscaled could not be asked who is calling: ${err instanceof Error ? err.message : String(err)}` }
  }
  // A caller that is not a tailnet node: a LAN neighbour, or a local process on loopback.
  if (answer.status === 404) return { kind: 'none' }
  if (answer.status !== 200) return { kind: 'error', reason: `tailscaled answered whois with HTTP ${answer.status}.` }
  let body: { Node?: { StableID?: unknown; Name?: unknown; Tags?: unknown } }
  try {
    body = JSON.parse(answer.body) as typeof body
  } catch {
    return { kind: 'error', reason: 'tailscaled answered whois with something that is not JSON.' }
  }
  const n = body.Node
  if (!n || typeof n.StableID !== 'string' || n.StableID === '') {
    return { kind: 'error', reason: 'tailscaled answered whois without a node.' }
  }
  return { kind: 'node', node: { stableId: n.StableID, name: typeof n.Name === 'string' ? n.Name.replace(/\.$/, '') : '', tags: strings(n.Tags) } }
}

/** This node, from `/localapi/v0/status`. `Self.ID` is the node's StableID. */
export async function selfStatus(signal?: AbortSignal): Promise<SelfResult> {
  let answer: Answer
  try {
    answer = await get('/localapi/v0/status?peers=false', signal)
  } catch (err) {
    return { ok: false, reason: `tailscaled did not answer: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (answer.status !== 200) return { ok: false, reason: `tailscaled answered status with HTTP ${answer.status}.` }
  let body: { BackendState?: unknown; TUN?: unknown; Self?: { ID?: unknown; TailscaleIPs?: unknown } }
  try {
    body = JSON.parse(answer.body) as typeof body
  } catch {
    return { ok: false, reason: 'tailscaled answered status with something that is not JSON.' }
  }
  const id = body.Self?.ID
  return {
    ok: true,
    self: {
      state: typeof body.BackendState === 'string' ? body.BackendState : 'unknown',
      ...(typeof id === 'string' && id !== '' ? { stableId: id } : {}),
      ips: strings(body.Self?.TailscaleIPs),
      tun: body.TUN !== false,
    },
  }
}
