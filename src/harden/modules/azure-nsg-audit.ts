// Azure network security group audit (check-only).
//
// The Azure counterpart of the AWS security-group audit and the GCP firewall audit, making the
// same judgement: an inbound Allow rule that admits the whole internet is a finding on any port,
// and on SSH or the gateway it is the finding the audit exists for.
//
// Azure states "the internet" in more ways than the other two. A source of `*` means any address,
// `Internet` is a service tag meaning the same thing, and `0.0.0.0/0` and `::/0` are the CIDRs
// the other clouds use. A rule can also carry a list of sources instead of one. Treating only the
// CIDRs as open would pass a rule written the way the Azure portal writes it by default.

import type { HardeningModule, RemoteExec, CheckResult, ApplyResult } from '../types.js'
import { GATEWAY_PORT } from '../../openclaw/run-flags.js'
import { azureContext, armGet, explainFailure, isClawopsResource, type ArmList } from '../azure-api.js'

/** Every spelling of "anywhere" Azure accepts in a source address. */
const WORLD = new Set(['*', 'internet', 'any', '0.0.0.0/0', '::/0'])

const NAMED_PORTS: Record<string, string> = {
  '22': 'SSH',
  [String(GATEWAY_PORT)]: 'the OpenClaw gateway',
}

export interface SecurityRule {
  name?: string
  properties?: {
    direction?: string
    access?: string
    protocol?: string
    sourceAddressPrefix?: string
    sourceAddressPrefixes?: string[]
    destinationPortRange?: string
    destinationPortRanges?: string[]
  }
}

export interface Nsg {
  name?: string
  properties?: { securityRules?: SecurityRule[] }
}

/** The sources on a rule that mean the whole internet, in the spellings the rule used. */
export function worldSources(rule: SecurityRule): string[] {
  const p = rule.properties ?? {}
  const all = [...(p.sourceAddressPrefix ? [p.sourceAddressPrefix] : []), ...(p.sourceAddressPrefixes ?? [])]
  return all.filter((s) => WORLD.has(s.trim().toLowerCase()))
}

/** "port 22 (SSH)", "ports 8000-9000", or every port when Azure's wildcard is used. */
export function describePorts(rule: SecurityRule): string {
  const p = rule.properties ?? {}
  const ranges = [
    ...(p.destinationPortRange ? [p.destinationPortRange] : []),
    ...(p.destinationPortRanges ?? []),
  ]
  if (ranges.length === 0) return 'no ports'
  const proto = (p.protocol ?? '*') === '*' ? 'any protocol' : (p.protocol as string)
  const parts = ranges.map((r) => {
    if (r === '*') return `every port on ${proto}`
    const named = NAMED_PORTS[r]
    if (named) return `port ${r} (${named})`
    return r.includes('-') ? `ports ${r}` : `port ${r}`
  })
  return parts.join(', ')
}

/** Inbound Allow rules on a clawops NSG that admit the whole internet. */
export function openFindings(groups: Nsg[]): string[] {
  const out: string[] = []
  for (const nsg of groups) {
    // By name, never by id: the id carries the resource group, which is also called clawops-*.
    if (!isClawopsResource(nsg.name, 'clawops-nsg')) continue
    for (const rule of nsg.properties?.securityRules ?? []) {
      const p = rule.properties ?? {}
      if ((p.direction ?? '').toLowerCase() !== 'inbound') continue
      if ((p.access ?? '').toLowerCase() !== 'allow') continue
      const world = worldSources(rule)
      if (world.length === 0) continue
      out.push(
        `${nsg.name}/${rule.name ?? 'unnamed rule'} admits ${world.join(' and ')} on ${describePorts(rule)}`,
      )
    }
  }
  return out
}

export const azureNsgAuditModule: HardeningModule = {
  id: 'azure-nsg-audit',
  label: 'Azure NSG audit (check-only)',
  defaultOn: true,
  providers: ['azure'],

  async check(_exec: RemoteExec): Promise<CheckResult> {
    const ctx = await azureContext()
    if (!ctx) {
      return {
        status: 'skipped',
        detail:
          'No Azure credentials or subscription resolved, so the network security groups could ' +
          'not be read. This says nothing about the rules themselves.',
      }
    }
    const r = await armGet<ArmList<Nsg>>(
      ctx,
      '/providers/Microsoft.Network/networkSecurityGroups?api-version=2023-05-01',
    )
    if (!r.ok) {
      return {
        status: 'skipped',
        detail:
          explainFailure(r, 'the network security groups', 'Microsoft.Network/networkSecurityGroups/read') +
          ' This says nothing about the rules themselves.',
      }
    }
    const findings = openFindings(r.body.value ?? [])
    return findings.length === 0
      ? { status: 'applied', detail: 'No clawops NSG rule admits the internet in this subscription.' }
      : { status: 'drifted', detail: `Open to the internet: ${findings.join('; ')}.` }
  },

  async apply(_exec: RemoteExec): Promise<ApplyResult> {
    return {
      changed: false,
      detail:
        'The NSG audit only reports. Narrow the rule in your plan with --ssh-cidr or ' +
        '--gateway-cidr and re-apply, so the change survives the next deploy.',
    }
  },
}
