// AWS Session Manager check module (check-only).
// Verifies the instance's IAM role has AmazonSSMManagedInstanceCore attached
// so emergency shell access works without opening port 22.

import type { HardeningModule, RemoteExec, CheckResult, ApplyResult } from '../types.js'

const SSM_POLICY_ARN = 'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore'

export const awsSsmCheckModule: HardeningModule = {
  id: 'aws-ssm-check',
  label: 'AWS SSM access (check-only)',
  defaultOn: true,
  providers: ['aws'],

  async check(_exec: RemoteExec): Promise<CheckResult> {
    try {
      const { EC2Client, DescribeInstancesCommand } = await import('@aws-sdk/client-ec2')
      const { IAMClient, ListAttachedRolePoliciesCommand } = await import('@aws-sdk/client-iam')

      // Find the instance profile role via the instance's tag
      const ec2 = new EC2Client({})
      const resp = await ec2.send(new DescribeInstancesCommand({
        Filters: [{ Name: 'tag:Name', Values: ['clawops'] }, { Name: 'instance-state-name', Values: ['running'] }],
      }))

      const instance = resp.Reservations?.[0]?.Instances?.[0]
      if (!instance) {
        return { status: 'skipped', detail: 'No running clawops instance found in this region' }
      }

      const profileArn = instance.IamInstanceProfile?.Arn
      if (!profileArn) {
        return { status: 'drifted', detail: 'Instance has no IAM instance profile attached' }
      }

      // Profile ARN: arn:aws:iam::<account>:instance-profile/<name>
      const roleName = profileArn.split('/').pop() ?? ''

      const iam = new IAMClient({})
      const policies = await iam.send(new ListAttachedRolePoliciesCommand({ RoleName: roleName }))
      const hasSSM = (policies.AttachedPolicies ?? []).some(
        (p: { PolicyArn?: string }) => p.PolicyArn === SSM_POLICY_ARN,
      )

      if (hasSSM) {
        return { status: 'applied', detail: `${roleName} has AmazonSSMManagedInstanceCore` }
      }
      return {
        status: 'drifted',
        detail: `${roleName} missing AmazonSSMManagedInstanceCore — SSM shell access unavailable`,
      }
    } catch (err) {
      return {
        status: 'skipped',
        detail: `AWS SDK unavailable: ${(err as Error).message}`,
      }
    }
  },

  async apply(_exec: RemoteExec): Promise<ApplyResult> {
    return {
      changed: false,
      detail: 'SSM check is read-only. Attach AmazonSSMManagedInstanceCore to the instance role to remediate.',
    }
  },
}
