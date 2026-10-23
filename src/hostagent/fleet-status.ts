// `clawops fleet status` and clawops_fleet_status — every stack's host agent, read from the
// operator's machine.
//
// Each host is read over the same SSH connection every other command uses, in one script: its
// agent.json, whether the service runs, and on a fleet member the firewall table and the tailnet.
// Nothing is changed. The two surfaces call fleetStatus(), so they cannot report a host
// differently.
//
// A host is judged on its own, then against the others read in the same run: a peer named by
// one host is only useful if that peer serves peers, carries the name it is reached by, and
// accepts the tag the caller carries (ADR 0015 §1). Those are the mistakes a fleet makes that no
// single host can see.

import type { SshSession } from '../transport/ssh.js'
import { sudoWrap } from '../transport/privileged.js'
import { NO_LOCAL_STATE, NO_OUTPUTS } from '../transport/conn.js'
import { HOST_AGENT_CONFIG_PATH, parseHostAgentConfig, type HostAgentConfig } from './config.js'
import { UNIT_NAME } from './install.js'
import { checkPeerTable, PEER_FW_UNIT, PEER_TABLE_LIST_CMD, PEER_PORT } from './peer-firewall.js'
import type { FleetPeer } from './fleet.js'

const SECTIONS = ['config', 'service', 'fwunit', 'fw', 'tailnet', 'listener'] as const
type Section = (typeof SECTIONS)[number]

const MARK = '@@clawops-fleet:'
const NO_SS = 'unknown'

/**
 * Everything fleetStatus needs from one host, in one round trip, as root: agent.json and the
 * nft table are root's to read. Each command's failure is part of the answer, so none stops it.
 */
export function fleetReadScript(): string {
  const tailnet = 'tailscale status --json --peers=false 2>/dev/null || tailscale status --json 2>/dev/null'
  const body: Record<Section, string> = {
    config: `cat ${HOST_AGENT_CONFIG_PATH} 2>/dev/null`,
    service: `systemctl is-active ${UNIT_NAME} 2>/dev/null`,
    fwunit: `systemctl is-enabled ${PEER_FW_UNIT} 2>/dev/null`,
    fw: `${PEER_TABLE_LIST_CMD} 2>/dev/null`,
    tailnet,
    // `unknown` where ss is missing, so a host without it is not reported as not listening.
    listener: `(command -v ss >/dev/null && ss -Htln 'sport = :${PEER_PORT}') 2>/dev/null || echo ${NO_SS}`,
  }
  // Each marker starts its own line: a file without a trailing newline, as agent.json is, would
  // otherwise run into the next one.
  return SECTIONS.map((s) => `printf '\\n%s\\n' '${MARK}${s}'; ${body[s]} || true`).join('\n')
}

/** The script's output, split back into its sections. */
export function splitSections(stdout: string): Partial<Record<Section, string>> | undefined {
  const out: Partial<Record<Section, string>> = {}
  let current: Section | undefined
  for (const line of stdout.split('\n')) {
    if (line.startsWith(MARK)) {
      const name = line.slice(MARK.length).trim() as Section
      current = SECTIONS.includes(name) ? name : undefined
      if (current) out[current] = ''
    } else if (current) {
      out[current] += `${line}\n`
    }
  }
  return out.config === undefined ? undefined : out
}

export interface TailnetSelf {
  state: string
  /** The MagicDNS name, without its trailing dot. */
  dnsName?: string
  hostName?: string
  tags: string[]
}

export interface FleetHost {
  stack: string
  /**
   * `ok`: a host agent runs and nothing below is wrong. `problems`: one runs, or is installed,
   * and something is. `none`: no host agent is installed. `undeployed`: the stack has no host yet,
   * or no longer has one. `unreachable`: it has one, and it was not read.
   */
  state: 'ok' | 'problems' | 'none' | 'undeployed' | 'unreachable'
  /** systemd's word for the service: active, inactive, failed, activating. */
  service?: string
  agentId?: string
  strict?: boolean
  installedAt?: string
  fleet?: {
    serves?: string
    peers: FleetPeer[]
    /** `ok`, or why the table is not the one install loaded. */
    firewall: string
    tailnet?: TailnetSelf
    /** On a host that serves peers: the addresses its peer listener is bound to, when ss could say. */
    listening?: string[]
  }
  problems: string[]
}

export interface FleetStatus {
  hosts: FleetHost[]
  /** Hosts with a host agent installed, and how many of them are fleet members. */
  agents: number
  members: number
}

/** The local addresses in `ss -Htln` output, or undefined when ss was not there to ask. */
export function parseListening(raw: string | undefined): string[] | undefined {
  if (raw === undefined || raw.trim() === NO_SS) return undefined
  return raw.split('\n').map((l) => l.trim().split(/\s+/)[3]).filter((a): a is string => !!a)
}

function parseTailnet(raw: string | undefined): TailnetSelf | undefined {
  if (!raw?.trim()) return undefined
  try {
    const body = JSON.parse(raw) as { BackendState?: unknown; Self?: { DNSName?: unknown; HostName?: unknown; Tags?: unknown } }
    const tags = Array.isArray(body.Self?.Tags) ? (body.Self.Tags as unknown[]).filter((t): t is string => typeof t === 'string') : []
    const dns = typeof body.Self?.DNSName === 'string' && body.Self.DNSName !== '' ? body.Self.DNSName.replace(/\.$/, '') : undefined
    const host = typeof body.Self?.HostName === 'string' ? body.Self.HostName : undefined
    return { state: String(body.BackendState ?? 'unknown'), ...(dns ? { dnsName: dns } : {}), ...(host ? { hostName: host } : {}), tags }
  } catch {
    return undefined
  }
}

/** One host, judged on what it holds. The cross-host checks are crossCheck's. */
export function assessHost(stack: string, stdout: string): FleetHost {
  const s = splitSections(stdout)
  if (!s) return { stack, state: 'unreachable', problems: ['The host did not run the status script.'] }
  if (!s.config?.trim()) return { stack, state: 'none', problems: [] }

  const parsed = parseHostAgentConfig(s.config)
  if (!parsed.ok) return { stack, state: 'problems', problems: [parsed.reason] }
  const c: HostAgentConfig = parsed.config
  const service = s.service?.trim() || 'unknown'
  const host: FleetHost = { stack, state: 'ok', service, agentId: c.agentId, strict: c.strict, installedAt: c.installedAt, problems: [] }

  if (c.stack !== stack) {
    host.problems.push(`Its host agent was installed for stack "${c.stack}", not "${stack}".`)
  }
  if (service !== 'active') {
    host.problems.push(`The host agent's service is ${service}. See \`journalctl -u ${UNIT_NAME}\` on the host.`)
  }

  if (c.fleet) {
    const fw = checkPeerTable(s.fw ?? '', c.fleet.peerUid)
    const tailnet = parseTailnet(s.tailnet)
    const listening = c.fleet.serves ? parseListening(s.listener) : undefined
    host.fleet = {
      ...(c.fleet.serves ? { serves: c.fleet.serves } : {}),
      peers: c.fleet.peers,
      firewall: fw.ok ? 'ok' : fw.reason,
      ...(tailnet ? { tailnet } : {}),
      ...(listening ? { listening } : {}),
    }
    const reinstall = 'Run `clawops agent install` again to restore it.'
    if (!fw.ok) host.problems.push(`${fw.reason} ${reinstall}`)
    if (s.fwunit?.trim() !== 'enabled') {
      host.problems.push(`${PEER_FW_UNIT} is ${s.fwunit?.trim() || 'missing'}, so the table will not be loaded at the next boot. ${reinstall}`)
    }
    if (!tailnet) {
      host.problems.push('tailscaled did not answer `tailscale status --json`.')
    } else if (tailnet.state !== 'Running') {
      host.problems.push(`The host is not on the tailnet: tailscaled reports ${tailnet.state}.`)
    } else if (c.fleet.serves && !tailnet.tags.includes(c.fleet.serves)) {
      host.problems.push(`It serves peers tagged ${c.fleet.serves} but no longer carries that tag itself (its tags: ${tailnet.tags.join(', ') || 'none'}).`)
    }
    // Only while the service runs: a stopped service is already reported, and is why.
    if (service === 'active' && listening?.length === 0) {
      host.problems.push(`It serves peers but nothing listens on port ${PEER_PORT}. The host agent waits for a tailnet address before it listens; see \`journalctl -u ${UNIT_NAME}\` on the host.`)
    }
  }

  if (host.problems.length > 0) host.state = 'problems'
  return host
}

/** Whether a `--peer` name is how that host is known on the tailnet. */
function namesHost(node: string, t: TailnetSelf): boolean {
  const n = node.toLowerCase()
  const dns = t.dnsName?.toLowerCase()
  return n === dns || n === dns?.split('.')[0] || n === t.hostName?.toLowerCase()
}

/** What is wrong between hosts: peers that cannot work, given what each peer holds. */
export function crossCheck(hosts: FleetHost[]): void {
  const byStack = new Map(hosts.map((h) => [h.stack, h]))
  for (const h of hosts) {
    for (const peer of h.fleet?.peers ?? []) {
      const p = byStack.get(peer.stack)
      // Not read in this run: another operator's stack, or one this config does not name.
      if (!p || p.state === 'unreachable') continue
      const where = `Peer ${peer.stack}`
      if (p.state === 'undeployed') {
        h.problems.push(`${where} is not deployed.`)
        continue
      }
      if (p.state === 'none') {
        h.problems.push(`${where} has no host agent.`)
        continue
      }
      if (!p.fleet?.serves) {
        h.problems.push(`${where} does not serve peers: its host agent was installed without --serve-peers.`)
        continue
      }
      const mine = h.fleet?.tailnet?.tags ?? []
      if (h.fleet?.tailnet && !mine.includes(p.fleet.serves)) {
        h.problems.push(`${where} answers only ${p.fleet.serves}, which this host does not carry (its tags: ${mine.join(', ') || 'none'}).`)
      }
      const t = p.fleet.tailnet
      if (t && !namesHost(peer.node, t)) {
        h.problems.push(`${where} is reached as "${peer.node}", but it is on the tailnet as "${t.dnsName ?? t.hostName ?? 'unknown'}".`)
      }
    }
  }
  for (const h of hosts) if (h.state === 'ok' && h.problems.length > 0) h.state = 'problems'
}

export interface FleetStatusDeps {
  /** A session to the stack's host, and how to give it back. Throws when the host cannot be reached. */
  open: (stack: string, signal: AbortSignal) => Promise<{ session: SshSession; release: () => void }>
  /** Per host. A host that does not answer in time is unreachable, and the rest are still read. */
  timeoutMs?: number
  concurrency?: number
}

/**
 * conn.ts's two answers for a stack with no host: no local state, or no outputs. A stack that was
 * registered and never brought up, or was torn down, is not a host that failed to answer.
 */
const UNDEPLOYED: readonly string[] = [NO_LOCAL_STATE, NO_OUTPUTS]

function unreachable(stack: string, err: unknown): FleetHost {
  const why = (err instanceof Error ? err.message : String(err)).split('\n')[0]!
  if (UNDEPLOYED.includes(why)) return { stack, state: 'undeployed', problems: [] }
  return { stack, state: 'unreachable', problems: [why.slice(0, 500)] }
}

async function readHost(stack: string, deps: FleetStatusDeps, signal?: AbortSignal): Promise<FleetHost> {
  const timeout = AbortSignal.timeout(deps.timeoutMs ?? 30_000)
  const each = signal ? AbortSignal.any([signal, timeout]) : timeout
  let conn: Awaited<ReturnType<FleetStatusDeps['open']>> | undefined
  try {
    conn = await deps.open(stack, each)
    const r = await conn.session.exec(sudoWrap(fleetReadScript()), each)
    if (!r.stdout.includes(MARK)) {
      const why = /password is required|a terminal is required/.test(r.stderr)
        ? 'Reading it needs passwordless sudo for the SSH user.'
        : (r.stderr.trim() || `The status script exited ${r.code}.`).slice(0, 300)
      return { stack, state: 'unreachable', problems: [why] }
    }
    return assessHost(stack, r.stdout)
  } catch (err) {
    return unreachable(stack, timeout.aborted ? new Error(`No answer within ${Math.round((deps.timeoutMs ?? 30_000) / 1000)} s.`) : err)
  } finally {
    conn?.release()
  }
}

/** Read every stack's host, a few at a time, and check them against each other. */
export async function fleetStatus(stacks: readonly string[], deps: FleetStatusDeps, signal?: AbortSignal): Promise<FleetStatus> {
  const hosts: FleetHost[] = new Array(stacks.length)
  let next = 0
  const worker = async () => {
    while (next < stacks.length) {
      const i = next++
      hosts[i] = await readHost(stacks[i]!, deps, signal)
    }
  }
  await Promise.all(Array.from({ length: Math.min(deps.concurrency ?? 4, stacks.length) }, worker))
  crossCheck(hosts)
  return {
    hosts,
    agents: hosts.filter((h) => h.state === 'ok' || h.state === 'problems').length,
    members: hosts.filter((h) => h.fleet).length,
  }
}

export type FleetStatusResult = { ok: true; status: FleetStatus } | { ok: false; reason: string }

/**
 * The stacks in ~/.clawops/config.json, or the ones named, read as fleetStatus reads them. The
 * CLI command and the MCP tool both call this, so they refuse the same names in the same words.
 */
export async function fleetStatusFromConfig(only: readonly string[], signal?: AbortSignal, deps: Partial<FleetStatusDeps> = {}): Promise<FleetStatusResult> {
  const { requireConfig } = await import('../config/store.js')
  const config = requireConfig()
  const known = Object.keys(config.stacks)
  const unknown = only.filter((s) => !known.includes(s))
  if (unknown.length > 0) {
    return { ok: false, reason: `No stack named ${unknown.map((s) => `"${s}"`).join(', ')} in your clawops config. Stacks: ${known.join(', ') || 'none'}.` }
  }
  const stacks = only.length > 0 ? [...new Set(only)] : known
  const open = deps.open ?? (async (stack: string, sig: AbortSignal) => {
    const { buildContext } = await import('../cli/context.js')
    const { resolveConn } = await import('../transport/conn.js')
    const { acquireSession } = await import('../transport/pool.js')
    const conn = await resolveConn(buildContext({ stack }))
    return acquireSession({ ...conn, signal: sig })
  })
  return { ok: true, status: await fleetStatus(stacks, { ...deps, open }, signal) }
}
