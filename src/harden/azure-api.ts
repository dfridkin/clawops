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

/**
 * Why a read did not produce a body. The distinction is the point: against a live subscription
 * the Defender read returned 404 "Subscription Not Registered", and reporting that as a missing
 * permission sends an operator to check RBAC when the fix is one `az provider register`.
 */
export type ArmFailure =
  | { reason: 'unregistered'; namespace: string }
  | { reason: 'forbidden' }
  | { reason: 'error'; status?: number }

export type ArmResult<T> = { ok: true; body: T } | ({ ok: false } & ArmFailure)

/** A subscription-scoped ARM GET. `pathAndQuery` starts after `/subscriptions/<id>`. */
export async function armGet<T>(
  ctx: AzureContext,
  pathAndQuery: string,
  signal?: AbortSignal,
): Promise<ArmResult<T>> {
  let res: Response
  try {
    res = await fetch(`${ARM}/subscriptions/${ctx.subscriptionId}${pathAndQuery}`, {
      headers: { authorization: `Bearer ${ctx.token}` },
      signal: signal ?? AbortSignal.timeout(20_000),
    })
  } catch {
    return { ok: false, reason: 'error' }
  }
  if (res.ok) return { ok: true, body: (await res.json()) as T }
  if (res.status === 403) return { ok: false, reason: 'forbidden' }
  if (res.status === 404) {
    // ARM says "Subscription Not Registered" for an unregistered namespace, and plain 404 for a
    // resource that simply is not there. Only the first is worth telling an operator how to fix.
    const body = await res.text().catch(() => '')
    if (/not registered/i.test(body)) {
      const ns = /providers\/([^/?]+)/.exec(pathAndQuery)?.[1] ?? 'the resource provider'
      return { ok: false, reason: 'unregistered', namespace: ns }
    }
  }
  return { ok: false, reason: 'error', status: res.status }
}

/**
 * Why the read failed, in a sentence an operator can act on. `subject` names what could not be
 * read, and `permission` the ARM action the identity would have needed.
 */
export function explainFailure(f: ArmFailure, subject: string, permission: string): string {
  if (f.reason === 'unregistered') {
    return (
      `The ${f.namespace} resource provider is not registered on this subscription, so ${subject} ` +
      `could not be read. Register it with \`az provider register --namespace ${f.namespace}\`, ` +
      'which costs nothing and turns nothing on by itself.'
    )
  }
  if (f.reason === 'forbidden') {
    return `The identity is not allowed to read ${subject}. It needs ${permission}; nothing else clawops does requires it.`
  }
  return `Could not read ${subject}${f.status ? ` (HTTP ${f.status})` : ''}.`
}

/**
 * Whether a resource provider is registered. Needed because two endpoints under the same
 * namespace do not agree: with Microsoft.Security unregistered, `pricings` returns 404 and
 * `jitNetworkAccessPolicies` returns 200 with an empty list. Reading that empty list as "JIT is
 * off" states a fact about a subscription that cannot have JIT at all.
 */
export async function providerRegistered(
  ctx: AzureContext,
  namespace: string,
  signal?: AbortSignal,
): Promise<boolean | undefined> {
  const r = await armGet<{ registrationState?: string }>(
    ctx,
    `/providers/${namespace}?api-version=2021-04-01`,
    signal,
  )
  if (!r.ok) return undefined
  return (r.body.registrationState ?? '').toLowerCase() === 'registered'
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
  const r = await armGet<ArmList<AzureVm>>(
    ctx,
    '/providers/Microsoft.Compute/virtualMachines?api-version=2023-09-01',
    signal,
  )
  if (!r.ok) return undefined
  return (r.body.value ?? []).find((vm) => isClawopsResource(vm.name, 'clawops-vm'))
}
