import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mockClient } from 'aws-sdk-client-mock'
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts'
import {
  S3Client, HeadBucketCommand, CreateBucketCommand, PutBucketVersioningCommand,
  PutPublicAccessBlockCommand,
} from '@aws-sdk/client-s3'
import { EC2Client, DescribeInstanceTypeOfferingsCommand } from '@aws-sdk/client-ec2'
import { awsPreflight } from '../../../src/providers/aws/preflight.js'

const sts = mockClient(STSClient)
const s3 = mockClient(S3Client)
const ec2 = mockClient(EC2Client)

/** An S3 error the SDK shape-matches on: the status code carries the meaning. */
function s3Error(status: number, name: string) {
  const err = new Error(name) as Error & { $metadata: { httpStatusCode: number } }
  err.$metadata = { httpStatusCode: status }
  return err
}

beforeEach(() => {
  sts.reset()
  s3.reset()
  ec2.reset()
  sts.on(GetCallerIdentityCommand).resolves({ Account: '614126170912' })
  s3.on(HeadBucketCommand).resolves({})
  ec2.on(DescribeInstanceTypeOfferingsCommand).resolves({
    InstanceTypeOfferings: [{ InstanceType: 't3.small' }],
  })
})
afterEach(() => {
  sts.restore()
  s3.restore()
  ec2.restore()
})

function find(checks: Awaited<ReturnType<typeof awsPreflight>>, id: string) {
  return checks.find((c) => c.id === id)
}

describe('awsPreflight', () => {
  it('passes when the account resolves, the bucket exists and the size is offered', async () => {
    const checks = await awsPreflight({ region: 'us-east-1', bucket: 'clawops-state' })
    expect(checks.every((c) => c.ok)).toBe(true)
  })

  it('names the account a deploy will land in', async () => {
    const checks = await awsPreflight({ region: 'us-east-1' })
    expect(find(checks, 'account-resolved')?.detail).toContain('614126170912')
  })

  it('stops at the credentials when none resolve', async () => {
    sts.on(GetCallerIdentityCommand).rejects(new Error('Unable to locate credentials'))
    const checks = await awsPreflight({ bucket: 'clawops-state' })
    expect(checks).toHaveLength(1)
    expect(checks[0]?.ok).toBe(false)
    expect(checks[0]?.detail).toMatch(/AWS_PROFILE|aws sso login/)
  })

  it('offers to create a bucket that is genuinely absent', async () => {
    s3.on(HeadBucketCommand).rejects(s3Error(404, 'NotFound'))
    const check = find(await awsPreflight({ region: 'us-east-1', bucket: 'gone' }), 'state-bucket')!
    expect(check.ok).toBe(false)
    expect(check.fix).toBeDefined()
    expect(check.mutates).toMatch(/Creates bucket s3:\/\/gone in us-east-1/)
  })

  it('offers no fix for a bucket it is merely denied', async () => {
    // 403 means the name is taken by another account, or the permission is missing. Creating
    // it would fail either way, and offering to would be a prompt that cannot succeed.
    s3.on(HeadBucketCommand).rejects(s3Error(403, 'Forbidden'))
    const check = find(await awsPreflight({ region: 'us-east-1', bucket: 'taken' }), 'state-bucket')!
    expect(check.ok).toBe(false)
    expect(check.fix).toBeUndefined()
    expect(check.detail).toMatch(/another account|cannot read it/)
  })

  it('creates the bucket with versioning and public access blocked', async () => {
    // Pulumi state with no history is a stack that can no longer be updated or destroyed.
    s3.on(HeadBucketCommand).rejects(s3Error(404, 'NotFound'))
    const check = find(await awsPreflight({ region: 'eu-west-1', bucket: 'new' }), 'state-bucket')!
    await check.fix!()
    expect(s3.commandCalls(CreateBucketCommand)).toHaveLength(1)
    expect(s3.commandCalls(PutBucketVersioningCommand)).toHaveLength(1)
    expect(s3.commandCalls(PutPublicAccessBlockCommand)).toHaveLength(1)
  })

  it('sends a location constraint everywhere except us-east-1, which rejects it', async () => {
    s3.on(HeadBucketCommand).rejects(s3Error(404, 'NotFound'))
    const outside = find(await awsPreflight({ region: 'eu-west-1', bucket: 'b' }), 'state-bucket')!
    await outside.fix!()
    expect(s3.commandCalls(CreateBucketCommand)[0]?.args[0].input).toHaveProperty(
      'CreateBucketConfiguration',
    )

    s3.resetHistory()
    const home = find(await awsPreflight({ region: 'us-east-1', bucket: 'b' }), 'state-bucket')!
    await home.fix!()
    expect(s3.commandCalls(CreateBucketCommand)[0]?.args[0].input).not.toHaveProperty(
      'CreateBucketConfiguration',
    )
  })

  it('skips the bucket check when no bucket is known', async () => {
    expect(find(await awsPreflight({ region: 'us-east-1' }), 'state-bucket')).toBeUndefined()
  })

  it('reports an instance type the region does not offer', async () => {
    ec2.on(DescribeInstanceTypeOfferingsCommand).resolves({ InstanceTypeOfferings: [] })
    const check = find(await awsPreflight({ region: 'us-west-1' }), 'instance-type-offered')!
    expect(check.ok).toBe(false)
    expect(check.detail).toMatch(/after the VPC, subnet, security group and address/)
  })

  it('asks about the size the caller named', async () => {
    const checks = await awsPreflight({ region: 'us-east-1', instanceType: 'c6g.metal' })
    expect(find(checks, 'instance-type-offered')?.label).toContain('c6g.metal')
  })

  it('says what it could not ask, rather than dropping the check', async () => {
    // A missing ec2:DescribeInstanceTypeOfferings permission should not fail a preflight over a
    // question clawops could not put — and staying silent is worse: the operator gets one
    // fewer line than everyone else and no idea why.
    ec2.on(DescribeInstanceTypeOfferingsCommand).rejects(new Error('UnauthorizedOperation'))
    const check = find(await awsPreflight({ region: 'us-east-1' }), 'instance-type-offered')!
    expect(check.unknown).toBe(true)
    expect(check.detail).toMatch(/could not ask EC2/)
    expect(check.detail).toMatch(/UnauthorizedOperation/)
    expect(check.detail).toMatch(/ec2:DescribeInstanceTypeOfferings/)
  })

  it('does not claim the instance type is fine when it could not ask', async () => {
    ec2.on(DescribeInstanceTypeOfferingsCommand).rejects(new Error('UnauthorizedOperation'))
    expect(find(await awsPreflight({ region: 'us-east-1' }), 'instance-type-offered')?.ok).toBe(false)
  })
})
