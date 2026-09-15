// Account-level setup an Azure subscription needs before clawops can deploy into it.
//
// A fresh subscription has no resource providers registered. Nothing says so until a deploy is
// already running, and then it says:
//
//   The subscription is not registered to use namespace 'Microsoft.Compute'
//
// which is the Azure counterpart of GCP's disabled-API failure, with the same shape: a fine
// error to get before provisioning and a poor one to get during it. This subscription had all
// three of Compute, Network and Storage unregistered, and `clawops doctor` said nothing,
// because it only checked that credentials resolve.
//
// The state backend is the other half. Pulumi's azblob backend authenticates with
// AZURE_STORAGE_ACCOUNT plus a key or SAS token — not with the CLI login that everything else
// here uses — so a deploy can pass every credential check and still fail to open its own state.

import process from 'node:process'
import { spawnSync } from 'node:child_process'
import type { PreflightCheck, PreflightOpts } from '../types.js'
import { resolveSubscriptionId } from './cli-auth.js'

const ARM = 'https://management.azure.com'
const API_VERSION = '2021-04-01'

/** Every resource provider the Pulumi program's resources need. */
export const REQUIRED_PROVIDERS = [
  { namespace: 'Microsoft.Compute', why: 'the virtual machine and its disk' },
  { namespace: 'Microsoft.Network', why: 'the virtual network, NSG, public IP and NIC' },
  { namespace: 'Microsoft.Storage', why: 'the azblob state backend' },
] as const

/**
 * A management token, by whichever route the operator authenticated.
 *
 * A service principal can be exchanged over plain HTTP, so that path needs nothing installed.
 * A CLI login cannot — the refresh token lives in the CLI's own cache — so that path asks `az`
 * for a token, which is reasonable: the CLI login only exists because `az` is installed.
 */
export async function managementToken(signal?: AbortSignal): Promise<string | undefined> {
  const tenantId = process.env['AZURE_TENANT_ID']
  const clientId = process.env['AZURE_CLIENT_ID']
  const clientSecret = process.env['AZURE_CLIENT_SECRET']

  if (tenantId && clientId && clientSecret) {
    try {
      const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: clientSecret,
          scope: `${ARM}/.default`,
        }),
        signal: signal ?? AbortSignal.timeout(10_000),
      })
      if (!res.ok) return undefined
      const body = (await res.json()) as { access_token?: unknown }
      return typeof body.access_token === 'string' ? body.access_token : undefined
    } catch {
      return undefined
    }
  }

  const result = spawnSync(
    'az',
    ['account', 'get-access-token', '--resource', ARM, '--query', 'accessToken', '-o', 'tsv'],
    { encoding: 'utf-8', timeout: 20_000 },
  )
  if (result.status !== 0) return undefined
  const token = result.stdout.trim()
  return token === '' ? undefined : token
}

/** Registration state for one namespace, or undefined when the call failed. */
async function registrationState(
  subscriptionId: string,
  namespace: string,
  token: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const res = await fetch(
      `${ARM}/subscriptions/${subscriptionId}/providers/${namespace}?api-version=${API_VERSION}`,
      { headers: { authorization: `Bearer ${token}` }, signal },
    )
    if (!res.ok) return undefined
    const body = (await res.json()) as { registrationState?: unknown }
    return typeof body.registrationState === 'string' ? body.registrationState : undefined
  } catch {
    return undefined
  }
}

async function register(
  subscriptionId: string,
  namespace: string,
  token: string,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(
    `${ARM}/subscriptions/${subscriptionId}/providers/${namespace}/register?api-version=${API_VERSION}`,
    { method: 'POST', headers: { authorization: `Bearer ${token}` }, signal },
  )
  if (!res.ok) {
    throw new Error(`Could not register ${namespace}: HTTP ${res.status} ${await res.text()}`)
  }
}

export async function azurePreflight(opts: PreflightOpts = {}): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = []
  const subscriptionId = resolveSubscriptionId()

  checks.push({
    id: 'subscription-resolved',
    label: 'Azure subscription is set',
    ok: Boolean(subscriptionId),
    detail: subscriptionId
      ? `Deploying into ${subscriptionId}`
      : 'No subscription resolved. Run `az login`, or set ARM_SUBSCRIPTION_ID.',
  })
  if (!subscriptionId) return checks

  // The state backend is checked whether or not a token resolves: it is pure environment, and
  // it is the failure that looks least like its cause — every credential check passes and
  // Pulumi still cannot open its own state.
  checks.push(stateBackendCheck(opts.bucket))

  const token = await managementToken(opts.signal)
  if (!token) {
    checks.push({
      id: 'management-token',
      label: 'Azure management API reachable',
      ok: false,
      detail:
        'Could not get a management token. Run `az login`, or set AZURE_TENANT_ID + ' +
        'AZURE_CLIENT_ID + AZURE_CLIENT_SECRET for a service principal.',
    })
    return checks
  }

  for (const provider of REQUIRED_PROVIDERS) {
    const state = await registrationState(subscriptionId, provider.namespace, token, opts.signal)
    const registered = state === 'Registered'
    checks.push({
      id: `rp-${provider.namespace.split('.')[1]?.toLowerCase()}`,
      label: `${provider.namespace} registered`,
      ok: registered,
      detail: registered
        ? undefined
        : `${state ?? 'unknown'} — needed for ${provider.why}. Nothing can be provisioned ` +
          'without it, and registration takes a couple of minutes.',
      ...(registered
        ? {}
        : {
            mutates: `Registers the ${provider.namespace} resource provider on subscription ${subscriptionId}`,
            fix: () => register(subscriptionId, provider.namespace, token, opts.signal),
          }),
    })
  }

  return checks
}

/**
 * Pulumi's azblob backend reads its own credentials from the environment and ignores the CLI
 * login, so this is an environment check rather than an API call.
 */
export function stateBackendCheck(container?: string): PreflightCheck {
  const account = process.env['AZURE_STORAGE_ACCOUNT']
  const hasSecret = Boolean(
    process.env['AZURE_STORAGE_KEY'] ?? process.env['AZURE_STORAGE_SAS_TOKEN'],
  )
  const ok = Boolean(account) && hasSecret
  const where = container ? `azblob://${container}` : 'the azblob state backend'

  return {
    id: 'state-backend-credentials',
    label: 'azblob state backend is configured',
    ok,
    detail: ok
      ? `${where} on storage account ${account}`
      : `${where} needs AZURE_STORAGE_ACCOUNT and one of AZURE_STORAGE_KEY or ` +
        'AZURE_STORAGE_SAS_TOKEN. Pulumi authenticates to blob storage with these and not ' +
        'with your `az login`, so every other check here can pass and the deploy still fail ' +
        'to open its own state.',
  }
}
