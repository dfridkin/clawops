/**
 * The bits of the Compute API the GCP hardening modules need.
 *
 * These modules read cloud state rather than host state, the way the AWS ones do, so they use
 * the API and ignore the `exec` they are handed. Authentication is whatever ADC resolves, and
 * the project is resolved exactly as preflight resolves it, so a module reports on the project
 * a deploy would land in rather than whatever the ambient environment last pointed at.
 */
import { resolveProjectId } from '../providers/gcp/preflight.js'

export interface GcpContext {
  project: string
  token: string
}

/** Undefined when credentials or a project cannot be resolved; the caller reports why. */
export async function gcpContext(): Promise<GcpContext | undefined> {
  const project = resolveProjectId()
  if (!project) return undefined
  try {
    const { GoogleAuth } = await import('google-auth-library')
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })
    const client = await auth.getClient()
    const raw = await client.getAccessToken()
    const token = typeof raw === 'string' ? raw : (raw.token ?? undefined)
    return token ? { project, token } : undefined
  } catch {
    return undefined
  }
}

export async function computeGet<T>(
  ctx: GcpContext,
  pathAndQuery: string,
  signal?: AbortSignal,
): Promise<T | undefined> {
  try {
    const res = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${ctx.project}/${pathAndQuery}`,
      { headers: { authorization: `Bearer ${ctx.token}` }, signal },
    )
    if (!res.ok) return undefined
    return (await res.json()) as T
  } catch {
    return undefined
  }
}

/** The clawops instance, found by name across zones so no zone has to be configured. */
export interface GceInstance {
  name?: string
  zone?: string
  shieldedInstanceConfig?: {
    enableSecureBoot?: boolean
    enableVtpm?: boolean
    enableIntegrityMonitoring?: boolean
  }
  metadata?: { items?: Array<{ key?: string; value?: string }> }
}

export async function findClawopsInstance(
  ctx: GcpContext,
  signal?: AbortSignal,
): Promise<GceInstance | undefined> {
  type Aggregated = { items?: Record<string, { instances?: GceInstance[] }> }
  // No server-side name filter: Pulumi auto-names the resource, so the instance is
  // `clawops-instance-<suffix>` and an exact match finds nothing. Matching a prefix here found
  // a live instance that an exact match had reported as absent.
  const body = await computeGet<Aggregated>(ctx, 'aggregated/instances', signal)
  for (const scope of Object.values(body?.items ?? {})) {
    for (const inst of scope.instances ?? []) {
      if (isClawopsInstance(inst.name)) return inst
    }
  }
  return undefined
}

/** `clawops-instance` as deployed, with whatever suffix Pulumi gave it. */
export function isClawopsInstance(name: string | undefined): boolean {
  return typeof name === 'string' && name.startsWith('clawops-instance')
}

/** Instance metadata wins over project metadata, so read it where the deploy set it. */
export function metadataValue(inst: GceInstance, key: string): string | undefined {
  return inst.metadata?.items?.find((i) => i.key === key)?.value
}
