// The one firewall rule a host agent needs: the gateway container reaching it over the Docker
// bridge. Used by `agent install` and `agent uninstall`, and by the ufw harden module, whose
// `ufw --force reset` would otherwise drop it and cut the gateway off from its host agent.

import { shellQuote } from '../transport/privileged.js'

export const HOST_AGENT_UFW_COMMENT = 'clawops host agent'

export interface Listen { address: string; port: number }

/** Only the Docker bridge, only the server's address and port. */
export function ufwAllowRule(listen: Listen): string {
  return `ufw allow in on docker0 to ${listen.address} port ${listen.port} proto tcp comment ${shellQuote(HOST_AGENT_UFW_COMMENT)}`
}

export function ufwDeleteRule(listen: Listen): string {
  return `ufw delete allow in on docker0 to ${listen.address} port ${listen.port} proto tcp`
}

/** The `listen` field of an agent.json, or undefined when there is no host agent or it has none. */
export function listenFrom(agentJson: string): Listen | undefined {
  try {
    const parsed: unknown = JSON.parse(agentJson)
    const l = (parsed as { listen?: unknown } | null)?.listen as { address?: unknown; port?: unknown } | undefined
    if (l && typeof l.address === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(l.address) && typeof l.port === 'number' && Number.isInteger(l.port)) {
      return { address: l.address, port: l.port }
    }
  } catch { /* no host agent */ }
  return undefined
}

/**
 * A fleet member that serves peers takes one more: the peer port, only on `tailscale0` (ADR 0015
 * §2). Defence in depth: Linux accepts a packet for the tailnet address on any interface, and the
 * listener's whois check is what refuses a stranger who gets that far.
 */
export const PEER_UFW_COMMENT = 'clawops fleet peers'

export function ufwPeerAllowRule(port: number): string {
  return `ufw allow in on tailscale0 to any port ${port} proto tcp comment ${shellQuote(PEER_UFW_COMMENT)}`
}

export function ufwPeerDeleteRule(port: number): string {
  return `ufw delete allow in on tailscale0 to any port ${port} proto tcp`
}

/** Whether an agent.json says this host serves peers, so harden's ufw reset keeps their rule. */
export function servesPeersFrom(agentJson: string): boolean {
  try {
    const parsed: unknown = JSON.parse(agentJson)
    const serves = (parsed as { fleet?: { serves?: unknown } } | null)?.fleet?.serves
    return typeof serves === 'string' && serves !== ''
  } catch {
    return false
  }
}
