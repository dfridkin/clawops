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
import path from 'node:path'
import { readFileSync } from 'node:fs'
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

/**
 * The project a deploy will land in.
 *
 * The env vars come first and in the Pulumi GCP provider's own order, so preflight resolves
 * what the deploy resolves. `GOOGLE_PROJECT` was missing from this list and is the provider's
 * first choice.
 *
 * gcloud's configured project is last, and is read here because this check's own remedy told
 * the operator to set it — `gcloud config set project` is the obvious thing to do and did
 * nothing, since the provider never reads gcloud's config. Rather than withdraw the advice,
 * clawops honours it: the resolved project is written to stack config as `gcp:project` during
 * apply, so the deploy uses the value this check measured instead of whatever the environment
 * happens to hold later.
 */
export function resolveProjectId(): string | undefined {
  return (
    process.env['GOOGLE_PROJECT'] ??
    process.env['GOOGLE_CLOUD_PROJECT'] ??
    process.env['GCLOUD_PROJECT'] ??
    process.env['CLOUDSDK_CORE_PROJECT'] ??
    gcloudConfiguredProject() ??
    undefined
  )
}

/**
 * `core/project` from the active gcloud configuration, read from disk rather than by spawning
 * gcloud: the file is a documented layout, and clawops should not require the CLI on PATH to
 * answer a question about a file.
 *
 * Honours CLOUDSDK_CONFIG (the config directory) and CLOUDSDK_ACTIVE_CONFIG_NAME (which
 * configuration is active), the two env vars gcloud itself uses to redirect this.
 */
export function gcloudConfiguredProject(): string | undefined {
  try {
    const home = process.env['HOME'] ?? process.env['USERPROFILE']
    const dir =
      process.env['CLOUDSDK_CONFIG'] ?? (home ? path.join(home, '.config', 'gcloud') : undefined)
    if (!dir) return undefined

    const active =
      process.env['CLOUDSDK_ACTIVE_CONFIG_NAME'] ??
      readFileSync(path.join(dir, 'active_config'), 'utf-8').trim() ??
      'default'
    if (!active) return undefined

    const ini = readFileSync(path.join(dir, 'configurations', `config_${active}`), 'utf-8')
    return projectFromIni(ini)
  } catch {
    // No gcloud, no config, unreadable file — all mean "no answer", never an error. This is
    // the last fallback in a chain, not a requirement.
    return undefined
  }
}

/**
 * `project = <id>` from the `[core]` section. Sections matter: `project` under `[compute]` or
 * any other section is a different setting.
 */
export function projectFromIni(ini: string): string | undefined {
  let section = ''
  for (const line of ini.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith(';')) continue
    const header = /^\[(.+)\]$/.exec(trimmed)
    if (header) {
      section = header[1]?.trim() ?? ''
      continue
    }
    if (section !== 'core') continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    if (trimmed.slice(0, eq).trim() !== 'project') continue
    const value = trimmed.slice(eq + 1).trim()
    return value === '' ? undefined : value
  }
  return undefined
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
      : 'No project resolved. Run `gcloud config set project <id>`, or set GOOGLE_PROJECT.',
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
