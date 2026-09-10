// Unit tests for AWS hardening modules using aws-sdk-client-mock.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { RemoteExec } from '../../src/harden/types.js'

const noopExec: RemoteExec = async () => ({ stdout: '', stderr: '', code: 0 })

describe('awsSgAuditModule', () => {
  beforeEach(() => vi.resetModules())

  async function auditWith(permissions: unknown[]) {
    const { mockClient: mc } = await import('aws-sdk-client-mock')
    const { EC2Client, DescribeSecurityGroupsCommand } = await import('@aws-sdk/client-ec2')
    const mock = mc(EC2Client)
    mock.on(DescribeSecurityGroupsCommand).resolves({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      SecurityGroups: [{ GroupId: 'sg-test', IpPermissions: permissions as any }],
    })
    const { awsSgAuditModule } = await import('../../src/harden/modules/aws-sg-audit.js')
    const result = await awsSgAuditModule.check(noopExec)
    mock.reset()
    return result
  }

  it('flags SSH open to the whole internet', async () => {
    // This case used to return "applied": port 22 was on an exemption list, on the
    // reasoning that it is a port clawops configures. N10 forbids exactly this rule, and
    // an audit that exempts it green-lights the finding it exists to catch.
    const result = await auditWith([
      { FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: '0.0.0.0/0' }] },
    ])
    expect(result.status).toBe('drifted')
    expect(result.detail).toMatch(/SSH/)
  })

  it('flags the gateway port open to the whole internet', async () => {
    const result = await auditWith([
      { FromPort: 18789, ToPort: 18789, IpRanges: [{ CidrIp: '0.0.0.0/0' }] },
    ])
    expect(result.status).toBe('drifted')
    expect(result.detail).toMatch(/gateway/)
  })

  it('flags an IPv6 rule open to the whole internet', async () => {
    // ::/0 admits the internet just as 0.0.0.0/0 does, and lives in a separate list the
    // check never read.
    const result = await auditWith([
      { FromPort: 22, ToPort: 22, Ipv6Ranges: [{ CidrIpv6: '::/0' }] },
    ])
    expect(result.status).toBe('drifted')
    expect(result.detail).toMatch(/::\/0/)
  })

  it('is applied when every rule names a specific CIDR', async () => {
    const result = await auditWith([
      { FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: '10.0.0.1/32' }] },
      { FromPort: 18789, ToPort: 18789, IpRanges: [{ CidrIp: '10.0.0.0/8' }] },
    ])
    expect(result.status).toBe('applied')
  })

  it('returns drifted when unexpected port is open to 0.0.0.0/0', async () => {
    const { mockClient: mc } = await import('aws-sdk-client-mock')
    const { EC2Client, DescribeSecurityGroupsCommand } = await import('@aws-sdk/client-ec2')
    const mock = mc(EC2Client)
    mock.on(DescribeSecurityGroupsCommand).resolves({
      SecurityGroups: [{
        GroupId: 'sg-test',
        IpPermissions: [{
          FromPort: 3306,
          ToPort: 3306,
          IpRanges: [{ CidrIp: '0.0.0.0/0' }],
        }],
      }],
    })

    const { awsSgAuditModule } = await import('../../src/harden/modules/aws-sg-audit.js')
    const result = await awsSgAuditModule.check(noopExec)
    expect(result.status).toBe('drifted')
    expect(result.detail).toContain('3306')
    mock.reset()
  })

  it('apply() is a no-op (check-only module)', async () => {
    const { awsSgAuditModule } = await import('../../src/harden/modules/aws-sg-audit.js')
    const result = await awsSgAuditModule.apply(noopExec)
    expect(result.changed).toBe(false)
  })
})

describe('awsSsmCheckModule', () => {
  it('apply() is a no-op (check-only module)', async () => {
    const { awsSsmCheckModule } = await import('../../src/harden/modules/aws-ssm-check.js')
    const result = await awsSsmCheckModule.apply(noopExec)
    expect(result.changed).toBe(false)
  })
})

describe('awsGuardDutyModule', () => {
  beforeEach(() => vi.resetModules())

  it('check() returns applied when an ENABLED detector exists', async () => {
    const { mockClient: mc } = await import('aws-sdk-client-mock')
    const { GuardDutyClient, ListDetectorsCommand, GetDetectorCommand } = await import('@aws-sdk/client-guardduty')
    const mock = mc(GuardDutyClient)
    mock.on(ListDetectorsCommand).resolves({ DetectorIds: ['det-123'] })
    mock.on(GetDetectorCommand).resolves({ Status: 'ENABLED' })

    const { awsGuardDutyModule } = await import('../../src/harden/modules/aws-guardduty.js')
    const result = await awsGuardDutyModule.check(noopExec)
    expect(result.status).toBe('applied')
    mock.reset()
  })

  it('check() returns missing when no detectors', async () => {
    const { mockClient: mc } = await import('aws-sdk-client-mock')
    const { GuardDutyClient, ListDetectorsCommand } = await import('@aws-sdk/client-guardduty')
    const mock = mc(GuardDutyClient)
    mock.on(ListDetectorsCommand).resolves({ DetectorIds: [] })

    const { awsGuardDutyModule } = await import('../../src/harden/modules/aws-guardduty.js')
    const result = await awsGuardDutyModule.check(noopExec)
    expect(result.status).toBe('missing')
    mock.reset()
  })
})
