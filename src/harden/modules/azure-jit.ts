// Just-in-time VM access (check-only).
//
// JIT closes the management ports in the NSG and opens them per request, for a named source and
// a bounded window. It is a feature of Defender for Servers Plan 2, so a subscription on the
// free tier cannot have it at all; reporting "JIT is off" there without saying why would send an
// operator looking for a setting that is not available to them.
//
// It is also the one Azure control that would change the NSG underneath a deploy. clawops writes
// those rules from the plan, so enabling JIT here would mean the plan and the subscription
// disagreeing about what the firewall says. It reports, and the decision stays with the operator.

import type { HardeningModule, RemoteExec, CheckResult, ApplyResult } from '../types.js'
import {
  azureContext,
  armGet,
  explainFailure,
  isClawopsResource,
  findClawopsVm,
  providerRegistered,
  type ArmList,
} from '../azure-api.js'

export interface JitPolicy {
  name?: string
  properties?: { virtualMachines?: Array<{ id?: string; ports?: Array<{ number?: number }> }> }
}

/** The last segment of an ARM id: the resource's own name. */
export function resourceName(id: string | undefined): string | undefined {
  if (!id) return undefined
  const last = id.split('/').pop()
  return last === '' ? undefined : last
}

/** Whether any policy covers the clawops VM, matched on the VM's name rather than the id. */
export function coversClawopsVm(policies: JitPolicy[]): boolean {
  return policies.some((p) =>
    (p.properties?.virtualMachines ?? []).some((vm) =>
      isClawopsResource(resourceName(vm.id), 'clawops-vm'),
    ),
  )
}

export const azureJitModule: HardeningModule = {
  id: 'azure-jit',
  label: 'Azure JIT VM access check (check-only)',
  defaultOn: false,
  providers: ['azure'],

  async check(_exec: RemoteExec): Promise<CheckResult> {
    const ctx = await azureContext()
    if (!ctx) {
      return {
        status: 'skipped',
        detail: 'No Azure credentials or subscription resolved, so JIT policies could not be read.',
      }
    }
    const vm = await findClawopsVm(ctx)
    if (!vm) {
      return {
        status: 'skipped',
        detail:
          `No VM named clawops-vm found in ${ctx.subscriptionId}, so there is nothing for a JIT ` +
          'policy to cover.',
      }
    }
    /*
     * The registration check comes first, and is not belt and braces.
     *
     * With Microsoft.Security unregistered, this endpoint answers 200 with an empty list while
     * `pricings` under the same namespace answers 404. Reading that empty list as "no policy
     * covers the VM" reports a definite negative about a subscription that cannot have JIT at
     * all, and sends the operator looking for a policy to create rather than a provider to
     * register. Measured against a live subscription; both endpoints were checked.
     */
    const registered = await providerRegistered(ctx, 'Microsoft.Security')
    if (registered === false) {
      return {
        status: 'skipped',
        detail:
          'The Microsoft.Security resource provider is not registered on this subscription, so ' +
          'it has no Defender and therefore no JIT. Register it with `az provider register ' +
          '--namespace Microsoft.Security` if you want these checks to report.',
      }
    }
    const r = await armGet<ArmList<JitPolicy>>(
      ctx,
      '/providers/Microsoft.Security/jitNetworkAccessPolicies?api-version=2020-01-01',
    )
    if (!r.ok) {
      return {
        status: 'skipped',
        detail:
          explainFailure(r, 'JIT policies', 'Microsoft.Security/jitNetworkAccessPolicies/read') +
          ' JIT also requires Defender for Servers Plan 2, which this subscription may not have.',
      }
    }
    return coversClawopsVm(r.body.value ?? [])
      ? { status: 'applied', detail: 'A JIT policy covers the clawops VM.' }
      : {
          status: 'missing',
          detail:
            'No JIT policy covers the clawops VM. SSH and the gateway stay open to whatever ' +
            'CIDRs the plan named, rather than opening per request.',
        }
  },

  async apply(_exec: RemoteExec): Promise<ApplyResult> {
    return {
      changed: false,
      detail:
        'JIT needs Defender for Servers Plan 2, which is billed per VM per month, and it takes ' +
        'the NSG rules over from the plan that wrote them. Enable it in Defender for Cloud if ' +
        'you want it, and expect clawops plan to report the rules as drifted afterwards.',
    }
  },
}
