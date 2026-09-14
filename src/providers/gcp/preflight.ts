// Account-level setup a GCP project needs before clawops can deploy into it.
//
// None of this is infrastructure, and none of it belongs in the Pulumi program. The state
// bucket has to exist before Pulumi can run at all, and an API has to be enabled before the
// program's first API call — so both are checked here and fixed, with consent, by the wizard.
//
// Found the hard way: a project with storage enabled and compute not enabled looks perfectly
// healthy to `clawops doctor`, which only checks that credentials resolve. The first sign of
// trouble was a deploy failing with
//
//   Compute Engine API has not been used in project <id> before or it is disabled
//
// which is a fine error message to get before provisioning and a poor one to get during it.

import process from 'node:process'
import type { PreflightCheck, PreflightOpts } from '../types.js'

/** Every API the Pulumi program's resources need. */
const REQUIRED_APIS = [
  { service: 'compute.googleapis.com', why: 'Instance, Network, Subnetwork, Firewall, Address' },
  { service: 'storage.googleapis.com', why: 'the GCS state backend' },
]

/** Google's own token endpoint for whatever credentials ADC resolves. */
async function accessToken(): Promise<string | undefined> {
  try {
    const { GoogleAuth } = await import('google-auth-library')
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })
    const client = await auth.getClient()
    const token = await client.getAccessToken()
    return typeof token === 'string' ? token : (token.token ?? undefined)
  } catch {
    return undefined
  }
}

export function resolveProjectId(): string | undefined {
  return (
    process.env['GOOGLE_CLOUD_PROJECT'] ??
    process.env['GCLOUD_PROJECT'] ??
    process.env['CLOUDSDK_CORE_PROJECT'] ??
    undefined
  )
}

export async function gcpPreflight(opts: PreflightOpts = {}): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = []
  const project = resolveProjectId()

  // clawops never sets the GCP project — the Pulumi program relies on ambient config, so an
  // unset project fails somewhere deep rather than here.
  checks.push({
    id: 'project-resolved',
    label: 'GCP project is set',
    ok: Boolean(project),
    detail: project
      ? `Deploying into ${project}`
      : 'No project resolved. Set GOOGLE_CLOUD_PROJECT, or run `gcloud config set project <id>`.',
  })
  if (!project) return checks

  const token = await accessToken()
  if (!token) {
    checks.push({
      id: 'adc-usable',
      label: 'Application Default Credentials resolve',
      ok: false,
      detail:
        'Could not obtain a token from ADC. Run `gcloud auth application-default login` — ' +
        '`gcloud auth login` alone authenticates the CLI and leaves ADC unset.',
    })
    return checks
  }

  const enabled = await enabledServices(project, token, opts.signal)
  for (const api of REQUIRED_APIS) {
    const on = enabled?.has(api.service) ?? false
    checks.push({
      id: `api-${api.service.split('.')[0]}`,
      label: `${api.service} enabled`,
      ok: on,
      detail: on ? undefined : `Needed for ${api.why}. Nothing can be provisioned without it.`,
      mutates: on ? undefined : `Enables ${api.service} on project ${project}`,
      fix: on ? undefined : async () => { await enableService(project, api.service, token) },
    })
  }

  if (opts.bucket) {
    const exists = await bucketExists(opts.bucket, token, opts.signal)
    checks.push({
      id: 'state-bucket',
      label: `State bucket gs://${opts.bucket} exists`,
      ok: exists,
      detail: exists
        ? undefined
        : 'Pulumi needs its state backend before it can run, so clawops cannot create this ' +
          'as part of a deploy.',
      mutates: exists
        ? undefined
        : `Creates bucket gs://${opts.bucket} in project ${project}` +
          `${opts.region ? ` (${opts.region})` : ''}, with versioning on`,
      fix: exists
        ? undefined
        : async () => { await createBucket(opts.bucket!, project, token, opts.region) },
    })
  }

  return checks
}

// ── Google API calls ──────────────────────────────────────────────────────────
//
// Plain fetch against the REST endpoints rather than another @google-cloud/* dependency:
// these are three calls, and the SDKs for service usage and storage are large.

async function enabledServices(
  project: string,
  token: string,
  signal?: AbortSignal,
): Promise<Set<string> | undefined> {
  try {
    const out = new Set<string>()
    let pageToken: string | undefined
    do {
      const url =
        `https://serviceusage.googleapis.com/v1/projects/${project}/services` +
        `?filter=state:ENABLED&pageSize=200${pageToken ? `&pageToken=${pageToken}` : ''}`
      const res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal })
      if (!res.ok) return undefined
      const body = (await res.json()) as {
        services?: Array<{ config?: { name?: string } }>
        nextPageToken?: string
      }
      for (const s of body.services ?? []) if (s.config?.name) out.add(s.config.name)
      pageToken = body.nextPageToken
    } while (pageToken)
    return out
  } catch {
    return undefined
  }
}

async function enableService(project: string, service: string, token: string): Promise<void> {
  const res = await fetch(
    `https://serviceusage.googleapis.com/v1/projects/${project}/services/${service}:enable`,
    { method: 'POST', headers: { authorization: `Bearer ${token}` } },
  )
  if (!res.ok) {
    throw new Error(`Could not enable ${service}: ${res.status} ${await res.text()}`)
  }
}

async function bucketExists(
  bucket: string,
  token: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const res = await fetch(`https://storage.googleapis.com/storage/v1/b/${bucket}`, {
    headers: { authorization: `Bearer ${token}` },
    signal,
  })
  return res.ok
}

async function createBucket(
  bucket: string,
  project: string,
  token: string,
  region?: string,
): Promise<void> {
  const res = await fetch(
    `https://storage.googleapis.com/storage/v1/b?project=${project}`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: bucket,
        location: (region ?? 'US').toUpperCase(),
        // Versioning on, because this holds Pulumi state: a corrupted or truncated write
        // with no history is a stack that can no longer be updated or destroyed.
        versioning: { enabled: true },
        iamConfiguration: { uniformBucketLevelAccess: { enabled: true } },
      }),
    },
  )
  if (!res.ok) throw new Error(`Could not create gs://${bucket}: ${res.status} ${await res.text()}`)
}
