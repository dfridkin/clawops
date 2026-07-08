// AWS Security Group audit module (check-only).
// Warns if any ingress rule allows 0.0.0.0/0 on ports other than
// the configured SSH + gateway ports.

import type { HardeningModule, RemoteExec, CheckResult, ApplyResult } from '../types.js'

const EXPECTED_OPEN_PORTS = new Set([22, 18789])

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
          for (const range of rule.IpRanges ?? []) {
            if (range.CidrIp === '0.0.0.0/0' && !EXPECTED_OPEN_PORTS.has(fromPort)) {
              openRules.push(`port ${fromPort}–${toPort} open to 0.0.0.0/0 in ${sg.GroupId}`)
            }
          }
        }
      }

      if (openRules.length === 0) {
        return { status: 'applied', detail: 'No unexpected open ingress rules found' }
      }
      return {
        status: 'drifted',
        detail: `Open ingress rules detected: ${openRules.join('; ')}`,
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
