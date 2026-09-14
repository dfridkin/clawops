// Recognising `az login` as a credential.
//
// clawops accepted only a service principal, OIDC, or a managed identity on Azure:
//
//   No Azure credentials found. Set AZURE_CLIENT_ID + AZURE_TENANT_ID + AZURE_CLIENT_SECRET …
//
// Pulumi's azure-native provider authenticates through the Azure CLI when those are absent, so
// `az login` was enough to deploy and not enough to pass `clawops doctor`. The tool refused a
// credential it would then have used — the same shape as the GCP check that told operators to
// run `gcloud config set project` and then ignored the result.
//
// This reads the CLI's own profile rather than spawning `az`, matching how the GCP adapter
// reads Application Default Credentials off disk. A profile with no subscriptions is what
// `az logout` leaves behind, so an empty list is "not logged in" rather than "logged in with
// nothing".

import path from 'node:path'
import process from 'node:process'
import { readFileSync } from 'node:fs'

/** `~/.azure`, or wherever AZURE_CONFIG_DIR points — the CLI's own override. */
export function azureConfigDir(): string | undefined {
  const explicit = process.env['AZURE_CONFIG_DIR']
  if (explicit) return explicit
  const home = process.env['HOME'] ?? process.env['USERPROFILE']
  return home ? path.join(home, '.azure') : undefined
}

export interface AzureCliAccount {
  subscriptionId: string
  name: string
  /** The signed-in identity, for `doctor` to name. */
  user?: string
}

/**
 * The default subscription from an `azureProfile.json` body.
 *
 * Pure, because the shape of that file is the part worth pinning: the CLI writes it with a
 * UTF-8 BOM, which `JSON.parse` rejects.
 */
export function accountFromProfile(body: string): AzureCliAccount | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(body.replace(/^\uFEFF/, ''))
  } catch {
    return undefined
  }
  const subscriptions = (parsed as { subscriptions?: unknown[] } | null)?.subscriptions
  if (!Array.isArray(subscriptions)) return undefined

  const entries = subscriptions as Array<Record<string, unknown>>
  // `az account set` moves the isDefault flag; with none set, the CLI itself falls back to the
  // first entry. An empty list — what `az logout` leaves behind — falls out here as no account.
  const chosen = entries.find((s) => s['isDefault'] === true) ?? entries[0]
  if (!chosen) return undefined

  const id = typeof chosen['id'] === 'string' ? chosen['id'] : undefined
  if (!id) return undefined

  const user = chosen['user'] as { name?: unknown } | undefined
  return {
    subscriptionId: id,
    name: typeof chosen['name'] === 'string' ? chosen['name'] : id,
    ...(typeof user?.name === 'string' ? { user: user.name } : {}),
  }
}

/** The account `az login` left behind, if any. */
export function azureCliAccount(): AzureCliAccount | undefined {
  const dir = azureConfigDir()
  if (!dir) return undefined
  try {
    return accountFromProfile(readFileSync(path.join(dir, 'azureProfile.json'), 'utf-8'))
  } catch {
    // No CLI, never logged in, unreadable file — all mean no credential here.
    return undefined
  }
}

/**
 * The subscription a deploy will use.
 *
 * Pulumi reads ARM_SUBSCRIPTION_ID first and AZURE_SUBSCRIPTION_ID second; the CLI's default
 * is the fallback. Resolved in that order so `doctor` reports what apply will actually use.
 */
export function resolveSubscriptionId(): string | undefined {
  return (
    process.env['ARM_SUBSCRIPTION_ID'] ??
    process.env['AZURE_SUBSCRIPTION_ID'] ??
    azureCliAccount()?.subscriptionId
  )
}
