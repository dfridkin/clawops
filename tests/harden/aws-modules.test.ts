// Unit tests for AWS hardening modules using aws-sdk-client-mock.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { RemoteExec } from '../../src/harden/types.js'

const noopExec: RemoteExec = async () => ({ stdout: '', stderr: '', code: 0 })

describe('awsSgAuditModule', () => {
  beforeEach(() => vi.resetModules())

  it('returns applied when no 0.0.0.0/0 rules on unexpected ports', async () => {
    const { mockClient: mc } = await import('aws-sdk-client-mock')
    const { EC2Client, DescribeSecurityGroupsCommand } = await import('@aws-sdk/client-ec2')
    const mock = mc(EC2Client)
    mock.on(DescribeSecurityGroupsCommand).resolves({
      SecurityGroups: [{
        GroupId: 'sg-test',
        IpPermissions: [{
          FromPort: 22,
          ToPort: 22,
          IpRanges: [{ CidrIp: '0.0.0.0/0' }],
        }],
      }],
    })

    const { awsSgAuditModule } = await import('../../src/harden/modules/aws-sg-audit.js')
    const result = await awsSgAuditModule.check(noopExec)
    expect(result.status).toBe('applied')
    mock.reset()
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
