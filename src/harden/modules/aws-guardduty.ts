// AWS GuardDuty module (opt-in, ~$4/mo per account).
// Enables GuardDuty threat detection via the AWS SDK.

import type { HardeningModule, RemoteExec, CheckResult, ApplyResult } from '../types.js'

export const awsGuardDutyModule: HardeningModule = {
  id: 'aws-guardduty',
  label: 'AWS GuardDuty (opt-in, ~$4/mo)',
  defaultOn: false,
  providers: ['aws'],

  async check(_exec: RemoteExec): Promise<CheckResult> {
    try {
      const { GuardDutyClient, ListDetectorsCommand } = await import('@aws-sdk/client-guardduty')
      const client = new GuardDutyClient({})
      const resp = await client.send(new ListDetectorsCommand({}))
      const detectors = resp.DetectorIds ?? []

      if (detectors.length === 0) {
        return { status: 'missing', detail: 'GuardDuty not enabled in this region' }
      }

      // Verify at least one detector is ENABLED
      const { GetDetectorCommand } = await import('@aws-sdk/client-guardduty')
      for (const id of detectors) {
        const det = await client.send(new GetDetectorCommand({ DetectorId: id }))
        if (det.Status === 'ENABLED') {
          return { status: 'applied', detail: `GuardDuty enabled (detector: ${id})` }
        }
      }
      return { status: 'drifted', detail: 'GuardDuty detector exists but is not ENABLED' }
    } catch (err) {
      return { status: 'skipped', detail: `AWS SDK unavailable: ${(err as Error).message}` }
    }
  },

  async apply(_exec: RemoteExec): Promise<ApplyResult> {
    try {
      const { GuardDutyClient, CreateDetectorCommand } = await import('@aws-sdk/client-guardduty')
      const client = new GuardDutyClient({})
      const resp = await client.send(new CreateDetectorCommand({ Enable: true }))
      return {
        changed: true,
        detail: `GuardDuty enabled (detector: ${resp.DetectorId}). Note: billed ~$4/mo per account.`,
      }
    } catch (err) {
      throw new Error(`GuardDuty enable failed: ${(err as Error).message}`)
    }
  },
}
