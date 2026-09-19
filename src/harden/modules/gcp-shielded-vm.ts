// Shielded VM posture (check-only).
//
// Secure Boot, vTPM and integrity monitoring are set on the instance, and changing any of them
// requires the instance to be stopped. A hardening module that stops the gateway to harden it
// has taken the deployment down to improve it, so this reports and leaves the decision with the
// operator. The fix belongs in the deploy, not in a running host.

import type { HardeningModule, RemoteExec, CheckResult, ApplyResult } from '../types.js'
import { gcpContext, findClawopsInstance } from '../gcp-api.js'

export interface ShieldedState { secureBoot: boolean; vtpm: boolean; integrityMonitoring: boolean }

export function missingProtections(s: ShieldedState): string[] {
  const out: string[] = []
  if (!s.secureBoot) out.push('Secure Boot')
  if (!s.vtpm) out.push('vTPM')
  if (!s.integrityMonitoring) out.push('integrity monitoring')
  return out
}

export const gcpShieldedVmModule: HardeningModule = {
  id: 'gcp-shielded-vm',
  label: 'GCP Shielded VM check (check-only)',
  defaultOn: true,
  providers: ['gcp'],

  async check(_exec: RemoteExec): Promise<CheckResult> {
    const ctx = await gcpContext()
    if (!ctx) {
      return { status: 'skipped', detail: 'No GCP credentials or project resolved, so the instance could not be read.' }
    }
    const inst = await findClawopsInstance(ctx)
    if (!inst) {
      return {
        status: 'skipped',
        detail: `No instance named clawops-instance found in ${ctx.project}. Either the stack ` +
          'is not deployed there or the identity cannot list instances.',
      }
    }
    const cfg = inst.shieldedInstanceConfig ?? {}
    const state: ShieldedState = {
      secureBoot: cfg.enableSecureBoot === true,
      vtpm: cfg.enableVtpm === true,
      integrityMonitoring: cfg.enableIntegrityMonitoring === true,
    }
    const missing = missingProtections(state)
    return missing.length === 0
      ? { status: 'applied', detail: 'Secure Boot, vTPM and integrity monitoring are all on.' }
      : {
          status: 'missing',
          detail: `Not enabled: ${missing.join(', ')}. Turning these on requires stopping the ` +
            'instance, so clawops does not do it to a running gateway.',
        }
  },

  async apply(_exec: RemoteExec): Promise<ApplyResult> {
    return {
      changed: false,
      detail: 'Shielded VM settings cannot be changed on a running instance. Stop the instance ' +
        'and set them, accepting the downtime, or recreate the stack with them enabled.',
    }
  },
}
