// GCP VPC firewall audit (check-only).
//
// The GCP counterpart of the AWS security-group audit, and it makes the same judgement: a rule
// admitting 0.0.0.0/0 is a finding on any port, and on SSH or the gateway it is the finding the
// audit exists for. The AWS module once exempted exactly those two ports; this one never has.

import type { HardeningModule, RemoteExec, CheckResult, ApplyResult } from '../types.js'
import { GATEWAY_PORT } from '../../openclaw/run-flags.js'
import { gcpContext, computeGet } from '../gcp-api.js'

const WORLD = new Set(['0.0.0.0/0', '::/0'])
const NAMED_PORTS: Record<string, string> = { '22': 'SSH', [String(GATEWAY_PORT)]: 'the OpenClaw gateway' }

interface Firewall {
  name?: string
  network?: string
  direction?: string
  disabled?: boolean
  sourceRanges?: string[]
  allowed?: Array<{ IPProtocol?: string; ports?: string[] }>
}

/** "22", "18789", "8000-9000" or absent, which in GCP means every port for that protocol. */
export function describePorts(allowed: Firewall['allowed']): string {
  const parts: string[] = []
  for (const rule of allowed ?? []) {
    const proto = rule.IPProtocol ?? 'all'
    if (!rule.ports || rule.ports.length === 0) { parts.push(`all ${proto} ports`); continue }
    for (const p of rule.ports) {
      const named = NAMED_PORTS[p]
      parts.push(named ? `port ${p} (${named})` : `port ${p}`)
    }
  }
  return parts.length > 0 ? parts.join(', ') : 'no ports'
}

/**
 * The network's own name, out of the self-link the API returns:
 *
 *   https://www.googleapis.com/compute/v1/projects/<project>/global/networks/<name>
 *
 * Matching "clawops" anywhere in that URL matches the *project* too, so in a project called
 * `clawops-test` every rule on the default network was reported as a clawops rule open to the
 * internet. Only the last segment names the network.
 */
export function networkName(selfLink: string): string {
  return selfLink.split('/').pop() ?? ''
}

/** Ingress rules on a clawops network that admit the whole internet. */
export function openFindings(firewalls: Firewall[]): string[] {
  const out: string[] = []
  for (const fw of firewalls) {
    if (fw.disabled) continue
    // GCP defaults direction to INGRESS when the field is absent; egress is not this audit's job.
    if ((fw.direction ?? 'INGRESS') !== 'INGRESS') continue
    if (!networkName(fw.network ?? '').startsWith('clawops-')) continue
    const world = (fw.sourceRanges ?? []).filter((r) => WORLD.has(r))
    if (world.length === 0) continue
    out.push(`${fw.name ?? 'unnamed rule'} admits ${world.join(' and ')} on ${describePorts(fw.allowed)}`)
  }
  return out
}

export const gcpFirewallAuditModule: HardeningModule = {
  id: 'gcp-firewall-audit',
  label: 'GCP firewall audit (check-only)',
  defaultOn: true,
  providers: ['gcp'],

  async check(_exec: RemoteExec): Promise<CheckResult> {
    const ctx = await gcpContext()
    if (!ctx) {
      return {
        status: 'skipped',
        detail: 'No GCP credentials or project resolved, so the firewall could not be read. ' +
          'This says nothing about the rules themselves.',
      }
    }
    const body = await computeGet<{ items?: Firewall[] }>(ctx, 'global/firewalls')
    if (!body) {
      return {
        status: 'skipped',
        detail: `Could not list firewall rules in ${ctx.project}. The identity needs ` +
          'compute.firewalls.list; nothing else clawops does requires it.',
      }
    }
    const findings = openFindings(body.items ?? [])
    return findings.length === 0
      ? { status: 'applied', detail: `No clawops firewall rule admits the internet in ${ctx.project}.` }
      : { status: 'drifted', detail: `Open to the internet: ${findings.join('; ')}.` }
  },

  async apply(_exec: RemoteExec): Promise<ApplyResult> {
    return {
      changed: false,
      detail: 'The firewall audit only reports. Narrow the rule in your plan with --ssh-cidr ' +
        'or --gateway-cidr and re-apply, so the change survives the next deploy.',
    }
  },
}
