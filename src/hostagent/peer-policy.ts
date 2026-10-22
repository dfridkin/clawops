// What the tailnet's policy lets reach a host's peer port — ADR 0015 §6.
//
// clawops never edits the policy, and can't read it: the policy lives on the control server.
// What a node can read is the packet filter the control server compiled from it for this node,
// which tailscaled serves at /localapi/v0/debug-packet-filter-rules. Each rule names the sources
// allowed in, and the destinations and ports they may reach. On the default allow-all policy
// that is one rule from 0.0.0.0/0 and ::/0 to every port (measured on Headscale 0.27.1 and
// Tailscale 1.88.3), and the host agent's tag check is then the only barrier.

import type { Check } from '../diagnostics/index.js'
import { PEER_PORT } from './peer-firewall.js'

export interface FilterRule {
  SrcIPs?: string[]
  DstPorts?: Array<{ IP?: string; Ports?: { First?: number; Last?: number } }>
  IPProto?: number[]
}

/** An address range, as integers: an IPv4 and an IPv6 range never overlap. */
interface Range { v6: boolean; lo: bigint; hi: bigint }

const TCP = 6

function parseIp(ip: string): { v6: boolean; n: bigint } | undefined {
  if (ip.includes(':')) {
    const [head, tail] = ip.split('::') as [string, string?]
    const h = head ? head.split(':') : []
    const t = tail ? tail.split(':') : []
    if (tail === undefined && h.length !== 8) return undefined
    const groups = tail === undefined ? h : [...h, ...Array<string>(8 - h.length - t.length).fill('0'), ...t]
    if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return undefined
    return { v6: true, n: groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n) }
  }
  const parts = ip.split('.')
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return undefined
  return { v6: false, n: parts.reduce((acc, p) => (acc << 8n) | BigInt(Number(p)), 0n) }
}

/** A filter address: `*`, an address, a prefix, or `a-b`. `*` is every address of both families. */
export function parseRange(spec: string): Range[] {
  if (spec === '*') return [...parseRange('0.0.0.0/0'), ...parseRange('::/0')]
  if (spec.includes('-')) {
    const [a, b] = spec.split('-').map(parseIp)
    return a && b && a.v6 === b.v6 ? [{ v6: a.v6, lo: a.n, hi: b.n }] : []
  }
  const [addr, len] = spec.split('/')
  const ip = parseIp(addr ?? '')
  if (!ip) return []
  const bits = ip.v6 ? 128 : 32
  const l = len === undefined ? bits : Number(len)
  if (!Number.isInteger(l) || l < 0 || l > bits) return []
  const host = (1n << BigInt(bits - l)) - 1n
  return [{ v6: ip.v6, lo: ip.n & ~host, hi: (ip.n & ~host) | host }]
}

function covers(ranges: Range[], ip: string): boolean {
  const a = parseIp(ip)
  return !!a && ranges.some((r) => r.v6 === a.v6 && r.lo <= a.n && a.n <= r.hi)
}

/** The source ranges the filter lets reach any of `selfIps` on TCP `port`. */
export function sourcesToPort(rules: FilterRule[], selfIps: string[], port: number): Range[] {
  const out: Range[] = []
  for (const rule of rules) {
    if (rule.IPProto && rule.IPProto.length > 0 && !rule.IPProto.includes(TCP)) continue
    const reaches = (rule.DstPorts ?? []).some((d) => {
      const first = d.Ports?.First ?? 0
      const last = d.Ports?.Last ?? 65535
      return first <= port && port <= last && selfIps.some((ip) => covers(parseRange(d.IP ?? ''), ip))
    })
    if (reaches) for (const s of rule.SrcIPs ?? []) out.push(...parseRange(s))
  }
  return out
}

export interface TailnetNode { name: string; ips: string[]; tags: string[] }

/** This node's addresses and its peers, from `tailscale status --json`. */
export function nodesFromStatus(statusJson: string): { selfIps: string[]; peers: TailnetNode[] } | undefined {
  let s: { Self?: { TailscaleIPs?: unknown }; Peer?: Record<string, { DNSName?: unknown; HostName?: unknown; TailscaleIPs?: unknown; Tags?: unknown }> }
  try { s = JSON.parse(statusJson) as typeof s } catch { return undefined }
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  const selfIps = strings(s.Self?.TailscaleIPs)
  if (selfIps.length === 0) return undefined
  const peers = Object.values(s.Peer ?? {}).map((p) => ({
    name: (typeof p.DNSName === 'string' && p.DNSName ? p.DNSName.replace(/\.$/, '') : typeof p.HostName === 'string' ? p.HostName : '?'),
    ips: strings(p.TailscaleIPs),
    tags: strings(p.Tags),
  }))
  return { selfIps, peers }
}

/** The whole tailnet range Tailscale hands out, IPv4 and IPv6. */
const TAILNET = [...parseRange('100.64.0.0/10'), ...parseRange('fd7a:115c:a1e0::/48')]

function coversAll(sources: Range[], tailnet: Range[]): boolean {
  return tailnet.every((t) => sources.some((s) => s.v6 === t.v6 && s.lo <= t.lo && t.hi <= s.hi))
}

const REMEDY = 'give the tailnet the policy in the operations guide (Tailnet policy), which lets only tagged hosts reach the peer port'

/**
 * The doctor check for a host that serves peers: whether the tailnet policy keeps nodes without
 * the tag off the peer port, or leaves the host agent's tag check as the only barrier.
 */
export function peerPolicyCheck(rulesJson: string, statusJson: string, serves: string, port = PEER_PORT): Check {
  const name = 'Fleet policy'
  let rules: unknown
  try { rules = JSON.parse(rulesJson) } catch { rules = undefined }
  const nodes = nodesFromStatus(statusJson)
  if (!Array.isArray(rules) || !nodes) {
    return { name, status: 'warn', detail: `could not read the tailnet's packet filter, so whether nodes without ${serves} can reach port ${port} is unknown; the host agent's tag check still refuses them`, remedy: REMEDY }
  }
  const sources = sourcesToPort(rules as FilterRule[], nodes.selfIps, port)
  if (coversAll(sources, TAILNET)) {
    return { name, status: 'warn', detail: `every node on the tailnet can reach port ${port}, as on the default allow-all policy; the host agent's tag check is the only barrier`, remedy: REMEDY }
  }
  const open = nodes.peers.filter((p) => !p.tags.includes(serves) && p.ips.some((ip) => sources.some((s) => covers([s], ip))))
  if (open.length > 0) {
    const names = open.map((p) => p.name)
    return { name, status: 'warn', detail: `${open.length} node${open.length === 1 ? '' : 's'} without ${serves} can reach port ${port}: ${names.slice(0, 5).join(', ')}${names.length > 5 ? ', …' : ''}; the host agent's tag check refuses them`, remedy: REMEDY }
  }
  const tagged = nodes.peers.filter((p) => p.tags.includes(serves) && p.ips.some((ip) => sources.some((s) => covers([s], ip))))
  if (tagged.length === 0) {
    return { name, status: 'warn', detail: `no node on the tailnet can reach port ${port}, so no peer can query this host`, remedy: `allow ${serves} to ${serves}:${port} in the tailnet policy` }
  }
  return { name, status: 'pass', detail: `only ${serves} nodes can reach port ${port} (${tagged.length} now)` }
}
