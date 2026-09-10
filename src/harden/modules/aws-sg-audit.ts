// AWS Security Group audit module (check-only).
// Reports any ingress rule that admits the whole internet.
//
// This module used to exempt ports 22 and 18789 from the check, on the reasoning that they
// are "the configured SSH + gateway ports" — so a security group opening SSH or the gateway
// to 0.0.0.0/0 was reported as "No unexpected open ingress rules found". Those two are
// exactly what N10 forbids opening to the world, and they are the two an audit exists to
// catch. A wide rule on any port is a finding; on those, the most important one.

import type { HardeningModule, RemoteExec, CheckResult, ApplyResult } from '../types.js'
import { GATEWAY_PORT } from '../../openclaw/run-flags.js'

const WORLD = new Set(['0.0.0.0/0'])
const WORLD_V6 = new Set(['::/0'])

/** Ports whose exposure is worth naming, so the finding says what is at risk. */
const NAMED_PORTS: Record<number, string> = { 22: 'SSH', [GATEWAY_PORT]: 'the OpenClaw gateway' }

function describe(fromPort: number, toPort: number): string {
  const range = fromPort === toPort ? `port ${fromPort}` : `ports ${fromPort}-${toPort}`
  const named = NAMED_PORTS[fromPort]
  return named && fromPort === toPort ? `${range} (${named})` : range
}

export const awsSgAuditModule: HardeningModule = {
  id: 'aws-sg-audit',
  label: 'AWS SG audit (check-only)',
  defaultOn: true,
  providers: ['aws'],

  async check(_exec: RemoteExec): Promise<CheckResult> {
    // Uses AWS SDK — does not require SSH exec.
    // The actual SDK call happens in apply() which is only reached on 'missing'.
    // check() performs the SDK call directly.
    try {
      const { EC2Client, DescribeSecurityGroupsCommand } = await import('@aws-sdk/client-ec2')
      const client = new EC2Client({})
      const resp = await client.send(new DescribeSecurityGroupsCommand({
        Filters: [{ Name: 'tag:Name', Values: ['clawops'] }],
      }))

      const groups = resp.SecurityGroups ?? []
      const openRules: string[] = []

      for (const sg of groups) {
        for (const rule of sg.IpPermissions ?? []) {
          const fromPort = rule.FromPort ?? 0
          const toPort = rule.ToPort ?? 65535
          const where = describe(fromPort, toPort)
          for (const range of rule.IpRanges ?? []) {
            if (range.CidrIp && WORLD.has(range.CidrIp)) {
              openRules.push(`${where} open to ${range.CidrIp} in ${sg.GroupId}`)
            }
          }
          // IPv6 is a separate rule list on the same permission, and ::/0 admits the whole
          // internet just as 0.0.0.0/0 does. Checking only IpRanges missed it entirely.
          for (const range of rule.Ipv6Ranges ?? []) {
            if (range.CidrIpv6 && WORLD_V6.has(range.CidrIpv6)) {
              openRules.push(`${where} open to ${range.CidrIpv6} in ${sg.GroupId}`)
            }
          }
        }
      }

      if (openRules.length === 0) {
        return { status: 'applied', detail: 'No ingress rule admits the whole internet' }
      }
      return {
        status: 'drifted',
        detail: `Ingress open to the internet: ${openRules.join('; ')}`,
      }
    } catch (err) {
      return {
        status: 'skipped',
        detail: `AWS SDK unavailable: ${(err as Error).message}`,
      }
    }
  },

  // SG audit is check-only — apply() surfaces the finding but makes no changes.
  async apply(_exec: RemoteExec): Promise<ApplyResult> {
    return {
      changed: false,
      detail: 'SG audit is check-only. Review and tighten rules manually or re-run clawops up.',
    }
  },
}
