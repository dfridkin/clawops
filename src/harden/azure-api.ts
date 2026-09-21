/**
 * The bits of Azure Resource Manager the Azure hardening modules need.
 *
 * These modules read cloud state rather than host state, the way the AWS and GCP ones do, so
 * they use the API and ignore the `exec` they are handed. Authentication and the subscription
 * are resolved exactly as preflight resolves them, so a module reports on the subscription a
 * deploy would land in rather than whatever the ambient environment last pointed at.
 */
import { managementToken } from '../providers/azure/preflight.js'
import { resolveSubscriptionId } from '../providers/azure/cli-auth.js'

const ARM = 'https://management.azure.com'

export interface AzureContext {
  subscriptionId: string
  token: string
}

/** Undefined when credentials or a subscription cannot be resolved; the caller reports why. */
export async function azureContext(signal?: AbortSignal): Promise<AzureContext | undefined> {
  const subscriptionId = resolveSubscriptionId()
  if (!subscriptionId) return undefined
  const token = await managementToken(signal)
  return token ? { subscriptionId, token } : undefined
}

/** A subscription-scoped ARM GET. `pathAndQuery` starts after `/subscriptions/<id>`. */
export async function armGet<T>(
  ctx: AzureContext,
  pathAndQuery: string,
  signal?: AbortSignal,
): Promise<T | undefined> {
  try {
    const res = await fetch(`${ARM}/subscriptions/${ctx.subscriptionId}${pathAndQuery}`, {
      headers: { authorization: `Bearer ${ctx.token}` },
      signal: signal ?? AbortSignal.timeout(20_000),
    })
    if (!res.ok) return undefined
    return (await res.json()) as T
  } catch {
    return undefined
  }
}

/**
 * An ARM GET by full resource id, for the ids the API hands back rather than ones we compose.
 * A VM names its OS disk by id, and that id already carries the subscription and resource group.
 */
export async function armGetById<T>(
  ctx: AzureContext,
  id: string,
  apiVersion: string,
  signal?: AbortSignal,
): Promise<T | undefined> {
  try {
    const res = await fetch(`${ARM}${id}?api-version=${apiVersion}`, {
      headers: { authorization: `Bearer ${ctx.token}` },
      signal: signal ?? AbortSignal.timeout(20_000),
    })
    if (!res.ok) return undefined
    return (await res.json()) as T
  } catch {
    return undefined
  }
}

/**
 * Whether an Azure resource is one of ours, by its own name rather than its id.
 *
 * An ARM id carries the resource group in it:
 *
 *   /subscriptions/<id>/resourceGroups/clawops-prod/providers/Microsoft.Network/…/default-nsg
 *
 * and clawops names its resource group `clawops-<stack>`, so matching "clawops" anywhere in the
 * id marks every resource in the group as ours, including ones nobody here created. The GCP
 * firewall audit shipped with exactly that bug against a project called `clawops-test`. Only the
 * resource's own name decides.
 */
export function isClawopsResource(name: string | undefined, prefix: string): boolean {
  return typeof name === 'string' && name.startsWith(prefix)
}

export interface ArmList<T> {
  value?: T[]
}

export interface AzureVm {
  name?: string
  id?: string
  properties?: {
    securityProfile?: { encryptionAtHost?: boolean; securityType?: string }
    storageProfile?: { osDisk?: { managedDisk?: { id?: string } } }
  }
}

export interface AzureDisk {
  name?: string
  id?: string
  properties?: {
    encryption?: { type?: string; diskEncryptionSetId?: string }
    encryptionSettingsCollection?: { enabled?: boolean }
  }
}

/** The clawops VM, found by name prefix: Pulumi auto-names it `clawops-vm-<suffix>`. */
export async function findClawopsVm(
  ctx: AzureContext,
  signal?: AbortSignal,
): Promise<AzureVm | undefined> {
  const body = await armGet<ArmList<AzureVm>>(
    ctx,
    '/providers/Microsoft.Compute/virtualMachines?api-version=2023-09-01',
    signal,
  )
  return (body?.value ?? []).find((vm) => isClawopsResource(vm.name, 'clawops-vm'))
}
