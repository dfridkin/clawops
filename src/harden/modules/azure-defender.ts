// Microsoft Defender for Cloud coverage (check-only).
//
// Defender is billed per resource per month, and the plan that covers a VM is the one this
// reports on. A hardening module that silently enabled it would put a recurring charge on the
// subscription to satisfy a checkbox, which is not a decision clawops gets to make for an
// operator. It reports the tier and names what enabling it would cost them.

import type { HardeningModule, RemoteExec, CheckResult, ApplyResult } from '../types.js'
import { azureContext, armGet, explainFailure, type ArmList } from '../azure-api.js'

/** The plans that cover what clawops deploys: a VM, its disks, and the Key Vault it may use. */
export const RELEVANT_PLANS = ['VirtualMachines', 'KeyVaults'] as const

export interface Pricing {
  name?: string
  properties?: { pricingTier?: string; subPlan?: string }
}

/** Relevant plans that are on the free tier, which is to say not protecting anything. */
export function unprotectedPlans(pricings: Pricing[]): string[] {
  const wanted = new Set<string>(RELEVANT_PLANS)
  return pricings
    .filter((p) => p.name && wanted.has(p.name))
    .filter((p) => (p.properties?.pricingTier ?? 'Free').toLowerCase() !== 'standard')
    .map((p) => p.name as string)
}

export const azureDefenderModule: HardeningModule = {
  id: 'azure-defender',
  label: 'Azure Defender for Cloud check (check-only)',
  defaultOn: true,
  providers: ['azure'],

  async check(_exec: RemoteExec): Promise<CheckResult> {
    const ctx = await azureContext()
    if (!ctx) {
      return {
        status: 'skipped',
        detail: 'No Azure credentials or subscription resolved, so Defender could not be read.',
      }
    }
    const r = await armGet<ArmList<Pricing>>(
      ctx,
      '/providers/Microsoft.Security/pricings?api-version=2023-01-01',
    )
    if (!r.ok) {
      return {
        status: 'skipped',
        detail: explainFailure(r, 'Defender pricing', 'Microsoft.Security/pricings/read'),
      }
    }
    const off = unprotectedPlans(r.body.value ?? [])
    return off.length === 0
      ? { status: 'applied', detail: 'Defender covers virtual machines and Key Vault on this subscription.' }
      : {
          status: 'missing',
          detail:
            `Defender is on the free tier for: ${off.join(', ')}. The free tier reports ` +
            'recommendations and does not protect anything.',
        }
  },

  async apply(_exec: RemoteExec): Promise<ApplyResult> {
    return {
      changed: false,
      detail:
        'Defender is billed per resource per month, so clawops will not turn it on for you. ' +
        'Enable it per plan in Defender for Cloud once you have priced it for this subscription.',
    }
  },
}
