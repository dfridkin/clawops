// OS Login posture (check-only, and deliberately so).
//
// OS Login moves SSH authorisation from instance metadata keys to IAM. It is the stronger
// posture, and enabling it is precisely how clawops loses access to its own host: clawops
// authenticates with a key the deploy put in instance metadata, and an instance with
// enable-oslogin=TRUE ignores those keys. `clawops ssh`, `logs`, `gateway restart`, `harden`
// and the remote half of `doctor` would all stop working, with no way back in through clawops.
//
// So this module reports the setting and what it means for access. It does not set it. A
// hardening step whose success locks the operator out is not a hardening step.

import type { HardeningModule, RemoteExec, CheckResult, ApplyResult } from '../types.js'
import { gcpContext, findClawopsInstance, metadataValue } from '../gcp-api.js'

/** GCP accepts TRUE/true/1 and treats anything else, including absence, as off. */
export function osLoginEnabled(value: string | undefined): boolean {
  if (value === undefined) return false
  const v = value.trim().toLowerCase()
  return v === 'true' || v === '1' || v === 'yes'
}

export const gcpOsLoginModule: HardeningModule = {
  id: 'gcp-os-login',
  label: 'GCP OS Login check (check-only)',
  defaultOn: false,
  providers: ['gcp'],

  async check(_exec: RemoteExec): Promise<CheckResult> {
    const ctx = await gcpContext()
    if (!ctx) {
      return { status: 'skipped', detail: 'No GCP credentials or project resolved, so OS Login could not be read.' }
    }
    const inst = await findClawopsInstance(ctx)
    if (!inst) {
      return { status: 'skipped', detail: `No instance named clawops-instance found in ${ctx.project}.` }
    }
    const enabled = osLoginEnabled(metadataValue(inst, 'enable-oslogin'))
    return enabled
      ? {
          status: 'drifted',
          detail: 'OS Login is enabled, so the instance ignores metadata SSH keys. clawops ' +
            'authenticates with a metadata key, so its day-two commands will not connect ' +
            'unless your identity has roles/compute.osLogin and you reach the host another way.',
        }
      : {
          status: 'applied',
          detail: 'OS Login is off, which is what clawops key-based access requires. Enabling ' +
            'it is a stronger posture and would cut clawops off from this host.',
        }
  },

  async apply(_exec: RemoteExec): Promise<ApplyResult> {
    return {
      changed: false,
      detail: 'clawops will not enable OS Login: the instance would stop accepting the metadata ' +
        'key clawops connects with, and every day-two command would fail.',
    }
  },
}
