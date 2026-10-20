// Fleet membership at `agent install` — ADR 0015 §1.
//
// Two opt-ins, both off by default: `--serve-peers <tag>` (this host answers peers carrying the
// tag) and `--peer <stack>=<tailnet name>` (this host may query that one). Both make the host a
// fleet member, and every member gets the firewall table in peer-firewall.ts.
//
// Pure, so the flag checks and the tailnet check are tested without a host.

export interface FleetPeer { stack: string; node: string }

const TAG_RE = /^tag:[A-Za-z0-9][A-Za-z0-9-]*$/
const STACK_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/
// A MagicDNS name, short (`eu-gw`) or full (`eu-gw.tail1234.ts.net`).
const NODE_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/

/** `--peer eu=eu-gw` as a peer, or undefined when it is not in that form. */
export function parsePeer(raw: string): FleetPeer | undefined {
  const i = raw.indexOf('=')
  if (i <= 0) return undefined
  const stack = raw.slice(0, i).trim()
  const node = raw.slice(i + 1).trim()
  return STACK_RE.test(stack) && NODE_RE.test(node) ? { stack, node } : undefined
}

/** Everything wrong with the fleet flags, before anything touches the host. */
export function validateFleetOpts(opts: { stack: string; strict: boolean; servePeers?: string; peers: readonly string[] }): string[] {
  const errors: string[] = []
  if (opts.servePeers !== undefined && !TAG_RE.test(opts.servePeers)) {
    errors.push(`--serve-peers "${opts.servePeers}" is not a tailnet tag, such as tag:clawops-agent.`)
  }
  const seen = new Set<string>()
  for (const raw of opts.peers) {
    const peer = parsePeer(raw)
    if (!peer) {
      errors.push(`--peer "${raw}" is not in the form <stack>=<tailnet name>, such as eu=eu-gw.`)
      continue
    }
    if (peer.stack === opts.stack) errors.push(`--peer "${raw}" names this stack. A host answers for itself without being its own peer.`)
    else if (seen.has(peer.stack)) errors.push(`--peer names stack "${peer.stack}" more than once.`)
    seen.add(peer.stack)
  }
  // ADR 0015 §4: tailnet identity names the host, so another agent that can run commands in the
  // gateway container would query peers as this host.
  if (opts.peers.length > 0 && !opts.strict) {
    errors.push('--peer requires --strict: a peer sees any agent in this gateway\'s container as this host.')
  }
  return errors
}

export type TailnetCheck = { ok: true; tags: string[] } | { ok: false; reason: string }

/**
 * Whether `tailscale status --json` shows a running node that carries the tag it is to serve.
 *
 * Read back rather than trusted from `tailscale up`: a tag the control server refuses can leave
 * the command exiting 0 and the node untagged (SP-15 finding 2).
 */
export function checkTailnet(statusJson: string, serves: string | undefined): TailnetCheck {
  let body: { BackendState?: unknown; Self?: { Tags?: unknown } }
  try {
    body = JSON.parse(statusJson) as typeof body
  } catch {
    return { ok: false, reason: 'tailscaled did not answer `tailscale status --json`. A fleet host must be on the tailnet: run `clawops harden --tailscale` first.' }
  }
  if (body.BackendState !== 'Running') {
    return { ok: false, reason: `This host is not on the tailnet (tailscaled reports ${String(body.BackendState ?? 'no state')}). Join it first: \`clawops harden --tailscale\`.` }
  }
  const tags = Array.isArray(body.Self?.Tags) ? (body.Self.Tags as unknown[]).filter((t): t is string => typeof t === 'string') : []
  if (serves !== undefined && !tags.includes(serves)) {
    return {
      ok: false,
      reason:
        `This host does not carry ${serves} (its tags: ${tags.length > 0 ? tags.join(', ') : 'none'}). ` +
        'Join it with an auth key tagged with it, and make sure the tailnet policy\'s tagOwners allow the tag.',
    }
  }
  return { ok: true, tags }
}
