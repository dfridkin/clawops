// Routing a call to a peer — ADR 0015 §3, §4 and §5.
//
// A host agent with `--peer` entries forwards a read tool whose `stackName` names one of them to
// that peer's listener, and refuses everything else that names one. It does so only after its
// own guardrail has passed (hostAgentDispatch checks that first, and `--peer` requires
// `--strict`, so no other agent can act in this gateway's container), and only while the
// firewall table is the one install loaded: without it, any container here could query the
// peer as this host.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { HostAgentConfig } from './config.js'
import type { FleetPeer } from './fleet.js'
import { checkPeerTable, PEER_TABLE_LIST_CMD } from './peer-firewall.js'
import { runPeerCall, type PeerAnswer, type PeerCallRequest } from './peer-client.js'
import { HOST_AGENT_READ_TOOLS, HANDOFF_TOOLS } from './tools.js'
import { buildHandoff } from './handoff.js'
// fleet-status.ts reaches install.ts and the MCP server, which import the registry, which imports
// this module: so it is loaded where it is used.
import type { FleetHost, FleetStatus } from './fleet-status.js'

/** The `_meta` key a forwarded result carries, so the audit log names the peer that answered. */
export const FORWARDED_META = 'clawops/forwardedTo'

/** R14: what a host agent returns is capped, a forwarded answer included. */
const MAX_TEXT = 8 * 1024

export interface PeerRouteDeps {
  /** Ask a peer, as clawops-peer. */
  call: (req: PeerCallRequest, agent: HostAgentConfig) => Promise<PeerAnswer>
  /** The firewall table as the kernel holds it, checked against the uid install recorded. */
  table: (agent: HostAgentConfig) => Promise<{ ok: true } | { ok: false; reason: string }>
  /** This host, read as `clawops fleet status` reads a host, for `fleet: true`. */
  thisHost: (agent: HostAgentConfig) => Promise<FleetHost>
}

async function liveTable(agent: HostAgentConfig): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { acquireSession } = await import('../transport/pool.js')
  const { HOST_AGENT_CONN } = await import('../transport/conn.js')
  const { session, release } = await acquireSession(HOST_AGENT_CONN)
  try {
    const listed = await session.exec(`${PEER_TABLE_LIST_CMD} 2>/dev/null`)
    return checkPeerTable(listed.code === 0 ? listed.stdout : '', agent.fleet?.peerUid ?? 0)
  } finally {
    release()
  }
}

/** The status script, run here as root: the host agent is on the host it reports. */
async function readThisHost(agent: HostAgentConfig): Promise<FleetHost> {
  const { acquireSession } = await import('../transport/pool.js')
  const { HOST_AGENT_CONN } = await import('../transport/conn.js')
  const { shellQuote } = await import('../transport/privileged.js')
  const { assessHost, fleetReadScript } = await import('./fleet-status.js')
  const { session, release } = await acquireSession(HOST_AGENT_CONN)
  try {
    const r = await session.exec(`bash -c ${shellQuote(fleetReadScript())}`)
    return assessHost(agent.stack, r.stdout)
  } finally {
    release()
  }
}

const realDeps: PeerRouteDeps = {
  call: (req, agent) => runPeerCall(req, agent.fleet?.peerUid ?? 0),
  table: liveTable,
  thisHost: readThisHost,
}
let deps: PeerRouteDeps = realDeps

/** For tests: answer peer queries, the table check and this host's reading without a host. */
export function setPeerRouteDepsForTests(d?: Partial<PeerRouteDeps>): void {
  deps = { ...realDeps, ...d }
}

/** The peer a call's stack names, or undefined when it names this host, nothing, or a stranger. */
export function peerFor(agent: HostAgentConfig, requested: unknown): FleetPeer | undefined {
  if (typeof requested !== 'string' || requested === agent.stack) return undefined
  return agent.fleet?.peers.find((p) => p.stack === requested)
}

function refusal(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

/**
 * A call naming a peer that is not a read. Refused here, on the calling side, and recorded in
 * neither host's handoffs.jsonl: a handoff belongs to the host whose own agent asked, and the
 * operator's `status` for the peer must not show requests another host's agent made up (§3).
 */
export function peerWriteRefusal(tool: string, args: Record<string, unknown>, peer: FleetPeer): CallToolResult {
  const head = `Refused. "${peer.stack}" is a peer, and a host agent only reads its peers. `
  if (!HANDOFF_TOOLS.includes(tool)) {
    return refusal(`${head}${tool} on another host is done by the operator, from their own machine, on their own initiative.`)
  }
  const { command } = buildHandoff(tool, args, peer.stack)
  return refusal(`${head}The operator can run it from their own machine:\n\n  ${command}\n\nNothing was recorded on either host.`)
}

/** Why no peer may be queried right now, or undefined when one may. */
async function peerQueryBlocked(agent: HostAgentConfig): Promise<string | undefined> {
  // Install refuses --peer without --strict; this holds even if agent.json was edited after.
  if (!agent.strict) {
    return 'Refused: this host agent was installed without --strict, so a peer would see any agent in this gateway\'s container as this host. Reinstall with --strict.'
  }
  const table = await deps.table(agent)
  if (!table.ok) {
    return `Refused: peer queries need the fleet firewall table, and ${table.reason.replace(/^./, (c) => c.toLowerCase())} Run \`clawops agent install\` again to restore it.`
  }
  return undefined
}

function capped(text: string): string {
  return Buffer.byteLength(text) <= MAX_TEXT ? text : `${Buffer.from(text).subarray(0, MAX_TEXT - 40).toString('utf-8')}\n… (cut to fit 8 KB)`
}

/** Ask a peer one read tool, and say which host answered. */
export async function askPeer(agent: HostAgentConfig, peer: FleetPeer, tool: string, args: Record<string, unknown>): Promise<PeerAnswer> {
  const blocked = await peerQueryBlocked(agent)
  if (blocked) return { ok: false, reason: blocked }
  // `stackName`, where the tool has one, already names the peer: that is how it was routed here.
  return deps.call({ node: peer.node, tool, args }, agent)
}

/** A read tool naming a peer, forwarded; anything else naming one, refused. */
export async function routeToPeer(agent: HostAgentConfig, peer: FleetPeer, tool: string, args: Record<string, unknown>): Promise<CallToolResult> {
  if (!HOST_AGENT_READ_TOOLS.includes(tool)) return peerWriteRefusal(tool, args, peer)
  const answer = await askPeer(agent, peer, tool, args)
  const meta = { _meta: { [FORWARDED_META]: { stack: peer.stack, node: peer.node } } }
  if (!answer.ok) {
    const text = answer.reason.startsWith('Refused') ? answer.reason : `Peer ${peer.stack} (${peer.node}) did not answer: ${answer.reason}`
    return { ...refusal(text), ...meta }
  }
  const texts = answer.result.content.filter((c): c is { type: 'text'; text: string } => c.type === 'text').map((c) => c.text)
  return {
    content: [{ type: 'text', text: capped(`Answered by peer ${peer.stack} (${answer.answeredBy}).\n\n${texts.join('\n')}`) }],
    ...(answer.result.isError === true ? { isError: true } : {}),
    ...meta,
  }
}

const STATES: ReadonlySet<string> = new Set(['ok', 'problems', 'none', 'undeployed', 'unreachable'])

/**
 * A peer's account of itself, from its `fleet: true` answer. A peer's answer is data, so anything
 * that is not a host with the peer's own stack name is reported as such, not trusted.
 */
export function peerHostFrom(peer: FleetPeer, answer: PeerAnswer): FleetHost {
  if (!answer.ok) return { stack: peer.stack, state: 'unreachable', problems: [answer.reason] }
  const text = answer.result.content.find((c) => c.type === 'text')
  let host: unknown
  try { host = (JSON.parse(text && text.type === 'text' ? text.text : '') as { host?: unknown }).host } catch { host = undefined }
  const h = host as Partial<FleetHost> | undefined
  if (answer.result.isError === true || !h || typeof h.state !== 'string' || !STATES.has(h.state) || !Array.isArray(h.problems)) {
    const said = text && text.type === 'text' ? text.text.split('\n')[0]!.slice(0, 300) : 'nothing'
    return { stack: peer.stack, state: 'unreachable', problems: [`${answer.answeredBy} did not report itself: ${said}`] }
  }
  if (h.stack !== peer.stack) {
    return { stack: peer.stack, state: 'problems', problems: [`${answer.answeredBy} answers as stack "${String(h.stack)}", not "${peer.stack}". Check the --peer entry.`] }
  }
  return { ...(h as FleetHost), problems: h.problems.filter((p): p is string => typeof p === 'string') }
}

/**
 * `clawops_stacks_list` with `fleet: true` on a host agent: this host, read here, and each peer as
 * it reports itself, then checked against each other as `clawops fleet status` does. One hop: a
 * peer answers for itself only, so nothing reaches a peer's peers.
 */
export async function fleetFromHere(agent: HostAgentConfig, peers: readonly FleetPeer[], includeSelf: boolean): Promise<FleetStatus> {
  const [self, ...others] = await Promise.all([
    includeSelf ? deps.thisHost(agent) : Promise.resolve(undefined),
    ...peers.map(async (p) => peerHostFrom(p, await askPeer(agent, p, 'clawops_stacks_list', { fleet: true }))),
  ])
  const hosts = [...(self ? [self] : []), ...(others as FleetHost[])]
  const { crossCheck } = await import('./fleet-status.js')
  crossCheck(hosts)
  return { hosts, agents: hosts.filter((h) => h.agentId).length, members: hosts.filter((h) => h.fleet).length }
}

/** This host as a peer asked about it: `{ host }`, read here and judged on its own. */
export async function thisHostForPeer(agent: HostAgentConfig): Promise<FleetHost> {
  return deps.thisHost(agent)
}
