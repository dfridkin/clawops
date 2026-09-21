// Azure disk encryption posture (check-only).
//
// Azure encrypts every managed disk at rest with a platform-managed key, always, with no way to
// turn it off. A module that reported "disk encryption: missing" against that default would be
// stating something untrue about the deployment, so this reports what is actually variable:
// whether the key is yours rather than the platform's, and whether encryption at host is on.
//
// Encryption at host is the gap the default leaves. Without it the temp disk and the VM's cache
// of the OS disk are written to the host unencrypted; with it they are encrypted before they
// leave the machine. Turning it on requires the VM to be deallocated, so this reports and leaves
// the decision with the operator, the same judgement the GCP Shielded VM module makes.

import type { HardeningModule, RemoteExec, CheckResult, ApplyResult } from '../types.js'
import { azureContext, armGetById, findClawopsVm, type AzureDisk, type AzureVm } from '../azure-api.js'

export interface EncryptionPosture {
  /** Azure's own guarantee; true for every managed disk. */
  atRest: boolean
  /** A customer-managed key through a disk encryption set. */
  customerKey: boolean
  /** Temp disk and host cache encrypted too. */
  atHost: boolean
}

export function posture(vm: AzureVm, disk: AzureDisk | undefined): EncryptionPosture {
  const type = disk?.properties?.encryption?.type ?? ''
  return {
    atRest: true,
    customerKey: type.includes('CustomerKey'),
    atHost: vm.properties?.securityProfile?.encryptionAtHost === true,
  }
}

export function describe(p: EncryptionPosture): string[] {
  const gaps: string[] = []
  if (!p.atHost) gaps.push('encryption at host is off, so the temp disk and the OS disk cache are written to the host unencrypted')
  if (!p.customerKey) gaps.push('the disk uses a platform-managed key rather than one of yours')
  return gaps
}

export const azureDiskEncryptionModule: HardeningModule = {
  id: 'azure-disk-encryption',
  label: 'Azure disk encryption check (check-only)',
  defaultOn: true,
  providers: ['azure'],

  async check(_exec: RemoteExec): Promise<CheckResult> {
    const ctx = await azureContext()
    if (!ctx) {
      return {
        status: 'skipped',
        detail: 'No Azure credentials or subscription resolved, so the disk could not be read.',
      }
    }
    const vm = await findClawopsVm(ctx)
    if (!vm) {
      return {
        status: 'skipped',
        detail:
          `No VM named clawops-vm found in ${ctx.subscriptionId}. Either the stack is not ` +
          'deployed there or the identity cannot list virtual machines.',
      }
    }
    const diskId = vm.properties?.storageProfile?.osDisk?.managedDisk?.id
    const disk = diskId ? await armGetById<AzureDisk>(ctx, diskId, '2023-04-02') : undefined
    const gaps = describe(posture(vm, disk))
    return gaps.length === 0
      ? {
          status: 'applied',
          detail: 'Encrypted at rest with a customer-managed key, and encryption at host is on.',
        }
      : {
          status: 'missing',
          detail:
            `The OS disk is encrypted at rest, which Azure does for every managed disk. Beyond ` +
            `that: ${gaps.join('; ')}.`,
        }
  },

  async apply(_exec: RemoteExec): Promise<ApplyResult> {
    return {
      changed: false,
      detail:
        'Encryption at host cannot be turned on while the VM is running, and moving to a ' +
        'customer-managed key means a disk encryption set and a Key Vault that outlive the ' +
        'stack. Both belong in the deploy rather than in a running host.',
    }
  },
}
