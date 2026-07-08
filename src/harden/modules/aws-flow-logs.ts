// AWS VPC Flow Logs module (opt-in).
// Creates a CloudWatch log group and VPC flow log via the AWS SDK.
// Billed per GB ingested — opt-in only.

import type { HardeningModule, RemoteExec, CheckResult, ApplyResult } from '../types.js'

const LOG_GROUP = '/clawops/vpc-flow-logs'

export const awsFlowLogsModule: HardeningModule = {
  id: 'aws-flow-logs',
  label: 'AWS VPC Flow Logs (opt-in, billed)',
  defaultOn: false,
  providers: ['aws'],

  async check(_exec: RemoteExec): Promise<CheckResult> {
    try {
      const { EC2Client, DescribeFlowLogsCommand } = await import('@aws-sdk/client-ec2')

      // Find VPC tagged clawops
      const { EC2Client: EC2, DescribeVpcsCommand } = await import('@aws-sdk/client-ec2')
      const ec2 = new EC2({})
      const vpcs = await ec2.send(new DescribeVpcsCommand({
        Filters: [{ Name: 'tag:Name', Values: ['clawops'] }],
      }))
      const vpcId = vpcs.Vpcs?.[0]?.VpcId
      if (!vpcId) {
        return { status: 'skipped', detail: 'No clawops VPC found' }
      }

      const flowClient = new EC2Client({})
      const logs = await flowClient.send(new DescribeFlowLogsCommand({
        Filter: [{ Name: 'resource-id', Values: [vpcId] }],
      }))

      if ((logs.FlowLogs ?? []).length > 0) {
        return { status: 'applied', detail: `VPC Flow Logs active on ${vpcId}` }
      }
      return { status: 'missing', detail: `VPC Flow Logs not enabled on ${vpcId}` }
    } catch (err) {
      return { status: 'skipped', detail: `AWS SDK unavailable: ${(err as Error).message}` }
    }
  },

  async apply(_exec: RemoteExec): Promise<ApplyResult> {
    try {
      const {
        EC2Client,
        DescribeVpcsCommand,
        CreateFlowLogsCommand,
      } = await import('@aws-sdk/client-ec2')
      const {
        CloudWatchLogsClient,
        CreateLogGroupCommand,
      } = await import('@aws-sdk/client-cloudwatch-logs')
      const { IAMClient, CreateRoleCommand, AttachRolePolicyCommand } = await import('@aws-sdk/client-iam')

      const ec2 = new EC2Client({})
      const vpcs = await ec2.send(new DescribeVpcsCommand({
        Filters: [{ Name: 'tag:Name', Values: ['clawops'] }],
      }))
      const vpcId = vpcs.Vpcs?.[0]?.VpcId
      if (!vpcId) throw new Error('No clawops VPC found')

      // Create log group (idempotent — ResourceAlreadyExistsException is ignored)
      const cwl = new CloudWatchLogsClient({})
      try {
        await cwl.send(new CreateLogGroupCommand({ logGroupName: LOG_GROUP }))
      } catch (e) {
        if ((e as { name?: string }).name !== 'ResourceAlreadyExistsException') throw e
      }

      // Create or reuse the flow log delivery role
      const iam = new IAMClient({})
      const roleName = 'clawops-flow-logs-role'
      let roleArn: string
      try {
        const role = await iam.send(new CreateRoleCommand({
          RoleName: roleName,
          AssumeRolePolicyDocument: JSON.stringify({
            Version: '2012-10-17',
            Statement: [{ Effect: 'Allow', Principal: { Service: 'vpc-flow-logs.amazonaws.com' }, Action: 'sts:AssumeRole' }],
          }),
        }))
        roleArn = role.Role!.Arn!
        await iam.send(new AttachRolePolicyCommand({
          RoleName: roleName,
          PolicyArn: 'arn:aws:iam::aws:policy/CloudWatchLogsFullAccess',
        }))
      } catch (e) {
        if ((e as { name?: string }).name !== 'EntityAlreadyExists') throw e
        // Role already exists — fetch its ARN
        const { IAMClient: IAM2, GetRoleCommand } = await import('@aws-sdk/client-iam')
        const existing = await (new IAM2({})).send(new GetRoleCommand({ RoleName: roleName }))
        roleArn = existing.Role!.Arn!
      }

      await ec2.send(new CreateFlowLogsCommand({
        ResourceIds: [vpcId],
        ResourceType: 'VPC',
        TrafficType: 'ALL',
        LogDestinationType: 'cloud-watch-logs',
        LogGroupName: LOG_GROUP,
        DeliverLogsPermissionArn: roleArn,
      }))

      return { changed: true, detail: `VPC Flow Logs enabled → CloudWatch ${LOG_GROUP}` }
    } catch (err) {
      throw new Error(`VPC Flow Logs setup failed: ${(err as Error).message}`)
    }
  },
}
