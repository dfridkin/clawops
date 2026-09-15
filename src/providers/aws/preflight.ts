// Account-level setup an AWS account needs before clawops can deploy into it.
//
// AWS was the only cloud with no preflight at all. GCP checks its project, its APIs and its
// state bucket; Azure checks its subscription, its resource providers, its VM size and its
// state credentials. AWS checked that a credential existed and nothing else — so a first
// deploy went:
//
//   clawops doctor --provider aws   → ✓ aws              (exit 0)
//   clawops plan  --provider aws    → ✔ Plan generated   (exit 0)
//   clawops apply plan.json         → error: NoSuchBucket …
//
// Three green signals, then a raw Pulumi error naming an S3 bucket clawops had never mentioned.
// The plan half of that is fixed separately; this is the half that says so beforehand.
//
// There is no API-enablement step on AWS and no per-subscription SKU gating, so the checks that
// matter here are: which account the credentials actually resolve to, whether the state bucket
// exists, and whether the instance type is offered in the target region.

import process from 'node:process'
import type { PreflightCheck, PreflightOpts } from '../types.js'
import { INSTANCE_TYPE_MAP, DEFAULT_ALIAS } from './sizes.js'

/** The account the credentials resolve to, or undefined when they resolve to none. */
export async function callerAccount(signal?: AbortSignal): Promise<string | undefined> {
  try {
    const { STSClient, GetCallerIdentityCommand } = await import('@aws-sdk/client-sts')
    const client = new STSClient({})
    const result = await client.send(new GetCallerIdentityCommand({}), { abortSignal: signal })
    return result.Account ?? undefined
  } catch {
    return undefined
  }
}

/** Does the state bucket exist and can these credentials see it? */
export async function bucketExists(
  bucket: string,
  signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; reason: 'missing' | 'denied' | 'unknown'; detail: string }> {
  try {
    const { S3Client, HeadBucketCommand } = await import('@aws-sdk/client-s3')
    const client = new S3Client({})
    await client.send(new HeadBucketCommand({ Bucket: bucket }), { abortSignal: signal })
    return { ok: true }
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
    const detail = err instanceof Error ? err.message : String(err)
    // 404 is "no such bucket"; 403 is "someone else's bucket, or yours without permission".
    // Creating one on a 403 would fail anyway, and on a name that is taken it would fail
    // confusingly — so the two get different answers.
    if (status === 404) return { ok: false, reason: 'missing', detail }
    if (status === 403) return { ok: false, reason: 'denied', detail }
    return { ok: false, reason: 'unknown', detail }
  }
}

/** Create the state bucket, with the settings a state store should have. */
export async function createBucket(
  bucket: string,
  region: string,
  signal?: AbortSignal,
): Promise<void> {
  const {
    S3Client, CreateBucketCommand, PutBucketVersioningCommand, PutPublicAccessBlockCommand,
  } = await import('@aws-sdk/client-s3')
  const client = new S3Client({ region })

  await client.send(
    new CreateBucketCommand({
      Bucket: bucket,
      // us-east-1 is the one region that rejects an explicit LocationConstraint.
      ...(region === 'us-east-1'
        ? {}
        : { CreateBucketConfiguration: { LocationConstraint: region as never } }),
    }),
    { abortSignal: signal },
  )

  // Pulumi state with no history is a stack that can no longer be updated or destroyed.
  await client.send(
    new PutBucketVersioningCommand({
      Bucket: bucket,
      VersioningConfiguration: { Status: 'Enabled' },
    }),
    { abortSignal: signal },
  )

  await client.send(
    new PutPublicAccessBlockCommand({
      Bucket: bucket,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      },
    }),
    { abortSignal: signal },
  )
}

/** Is the instance type offered in this region? */
export async function instanceTypeOffered(
  instanceType: string,
  region: string,
  signal?: AbortSignal,
): Promise<{ offered: boolean } | { error: string }> {
  try {
    const { EC2Client, DescribeInstanceTypeOfferingsCommand } = await import('@aws-sdk/client-ec2')
    const client = new EC2Client({ region })
    const result = await client.send(
      new DescribeInstanceTypeOfferingsCommand({
        LocationType: 'region',
        Filters: [
          { Name: 'instance-type', Values: [instanceType] },
          { Name: 'location', Values: [region] },
        ],
      }),
      { abortSignal: signal },
    )
    return { offered: (result.InstanceTypeOfferings?.length ?? 0) > 0 }
  } catch (err) {
    // A missing ec2:DescribeInstanceTypeOfferings permission should not fail a preflight over a
    // question clawops could not ask — but staying silent about it is worse. The operator gets
    // one fewer line than everyone else and no idea why.
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

export async function awsPreflight(opts: PreflightOpts = {}): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = []
  const region = opts.region ?? process.env['AWS_REGION'] ?? 'us-east-1'

  const account = await callerAccount(opts.signal)
  checks.push({
    id: 'account-resolved',
    label: 'AWS credentials resolve to an account',
    ok: Boolean(account),
    detail: account
      ? `Deploying into ${account} (${region})`
      : 'No account resolved. Set AWS_PROFILE, or run `aws sso login --profile <name>`.',
  })
  if (!account) return checks

  if (opts.bucket) {
    const bucket = opts.bucket
    const result = await bucketExists(bucket, opts.signal)
    checks.push(
      result.ok
        ? { id: 'state-bucket', label: `State bucket s3://${bucket} exists`, ok: true }
        : {
            id: 'state-bucket',
            label: `State bucket s3://${bucket} exists`,
            ok: false,
            detail:
              result.reason === 'denied'
                ? `s3://${bucket} exists but these credentials cannot read it, or the name ` +
                  'belongs to another account. Bucket names are global.'
                : 'Pulumi needs its state backend before it can run, so clawops cannot create ' +
                  'this as part of a deploy.',
            // Only offer to create what is genuinely absent: a 403 means the name is taken or
            // the permission is missing, and creating it would fail either way.
            ...(result.reason === 'missing'
              ? {
                  mutates: `Creates bucket s3://${bucket} in ${region}, with versioning on and public access blocked`,
                  fix: () => createBucket(bucket, region, opts.signal),
                }
              : {}),
          },
    )
  }

  const instanceType = opts.instanceType ?? INSTANCE_TYPE_MAP[DEFAULT_ALIAS]
  const offering = await instanceTypeOffered(instanceType, region, opts.signal)
  checks.push(
    'error' in offering
      ? {
          id: 'instance-type-offered',
          label: `${instanceType} is offered in ${region}`,
          ok: false,
          unknown: true,
          detail:
            `clawops could not ask EC2 whether ${instanceType} is offered in ${region}: ` +
            `${offering.error}. This says nothing about the instance type — the usual cause ` +
            'is credentials without ec2:DescribeInstanceTypeOfferings, which nothing else ' +
            'needs. A deploy can still succeed.',
        }
      : {
          id: 'instance-type-offered',
          label: `${instanceType} is offered in ${region}`,
          ok: offering.offered,
          detail: offering.offered
            ? undefined
            : `${instanceType} is not offered in ${region}, so a deploy fails after the VPC, ` +
              'subnet, security group and address have been created. Pick another region, or ' +
              'pass --instance-type with a type this region has.',
        },
  )

  return checks
}
