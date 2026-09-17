/**
 * Where a stack's Pulumi state lives, named for it rather than asked for.
 *
 * Until now clawops had no convention: `clawops init` wrote the literal string `CHANGEME` into
 * the stateUrl and told the operator to edit it, and the setup wizard asked for a name with no
 * default and advised creating the bucket by hand. Both predate the account preflight, which
 * now offers to create the bucket itself — so the wizard was telling operators to do by hand
 * the one thing it was about to offer to do for them.
 *
 * The rule here is that **a name carries exactly the uniqueness its namespace demands**, and no
 * more. S3 and Cloud Storage share one global namespace across every customer, so those names
 * need something nobody else can hold. An Azure blob container is scoped to a storage account
 * the operator already named, so a discriminator there would be thirty-seven characters that
 * buy nothing. Mechanically appending an id to all three would be the obvious design and the
 * wrong one.
 */

export type CloudProvider = 'aws' | 'gcp' | 'azure'

/** What the caller knows about the account the stack will be deployed into. */
export interface StateBucketScope {
  /** AWS account id, or GCP project id. Azure needs none — see the note above. */
  account?: string
  /** Deployment region. Only AWS puts it in the name. */
  region?: string
}

export type DerivedName =
  | { ok: true; name: string }
  /**
   * Not an error to throw at the operator. It means clawops could not derive a name it would
   * stand behind — almost always because the credentials that name the account are missing —
   * and the caller should say so rather than invent a placeholder, which is what `CHANGEME`
   * did and why a stack could be born pointing at a bucket that could never exist.
   */
  | { ok: false; needs: string }

/**
 * The state bucket clawops would choose for this account.
 *
 * AWS carries the region because an S3 bucket is a regional resource and Pulumi reads and
 * writes state on every single operation: a bucket on another continent makes every `plan` and
 * `apply` slower for no reason the operator can see. The cost of the extra bucket is zero — S3
 * bills for storage and requests, never for the bucket itself.
 */
export function deriveStateBucket(provider: CloudProvider, scope: StateBucketScope): DerivedName {
  if (provider === 'azure') {
    // Scoped to AZURE_STORAGE_ACCOUNT, which the operator supplies. Nothing to disambiguate.
    return { ok: true, name: 'clawops-state' }
  }
  if (!scope.account) {
    return {
      ok: false,
      needs: provider === 'aws'
        ? 'an AWS account id — set AWS_PROFILE, or run `aws sso login --profile <name>`'
        : 'a GCP project — run `gcloud config set project <id>`, or set GOOGLE_CLOUD_PROJECT',
    }
  }
  if (provider === 'gcp') return { ok: true, name: `clawops-state-${scope.account}` }
  if (!scope.region) return { ok: false, needs: 'a region' }
  return { ok: true, name: `clawops-state-${scope.account}-${scope.region}` }
}

/** The scheme a derived name is addressed through, so callers build one URL and not three. */
export function stateUrlFor(provider: CloudProvider, bucket: string): string {
  const scheme = provider === 'aws' ? 's3://' : provider === 'gcp' ? 'gs://' : 'azblob://'
  // Azure's azblob backend addresses a container directly; the other two take a state prefix
  // inside the bucket, which is what keeps clawops' objects separable from anything else there.
  return provider === 'azure' ? `${scheme}${bucket}` : `${scheme}${bucket}/clawops`
}

const IPV4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/

/**
 * Whether a name the operator typed is one the provider will actually accept.
 *
 * These rules are the providers', not ours, and they are checked here because the alternative
 * is learning them from a creation failure — after the wizard has collected another dozen
 * answers. Each message says what to change rather than quoting the rule.
 */
export function validateStateBucket(provider: CloudProvider, name: string): true | string {
  const n = name.trim()
  if (n === '') return 'Required'
  if (n !== name) return 'No leading or trailing spaces'
  if (n.length < 3) return `Too short — ${labelFor(provider)} names are at least 3 characters`
  const max = 63
  if (n.length > max) return `Too long — ${labelFor(provider)} names are at most ${max} characters`
  if (n !== n.toLowerCase()) return 'Lowercase only'

  if (provider === 'azure') {
    // Letters, digits and single hyphens; a container name may not start, end, or double up on
    // one. Underscores and dots are legal in S3 and GCS but not here.
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(n)) {
      return 'Letters, digits and single hyphens only, starting and ending with a letter or digit'
    }
    return true
  }

  if (!/^[a-z0-9][a-z0-9._-]*[a-z0-9]$/.test(n)) {
    return 'Letters, digits, dots, hyphens and underscores only, starting and ending with a letter or digit'
  }
  if (n.includes('..')) return 'No consecutive dots'
  if (IPV4.test(n)) return 'Cannot be formatted as an IP address'

  if (provider === 'aws') {
    if (n.startsWith('xn--')) return 'Cannot start with "xn--"'
    if (n.startsWith('sthree-')) return 'Cannot start with "sthree-"'
    if (n.endsWith('-s3alias')) return 'Cannot end with "-s3alias"'
    if (n.endsWith('--ol-s3')) return 'Cannot end with "--ol-s3"'
    if (n.includes('_')) return 'Underscores are not allowed in S3 bucket names'
    return true
  }

  // GCS reserves its own name and anything that reads like it, including misspellings, which
  // is why this is a contains-check and not a prefix-check.
  if (n.startsWith('goog')) return 'Cannot start with "goog"'
  if (n.includes('google')) return 'Cannot contain "google"'
  return true
}

function labelFor(provider: CloudProvider): string {
  if (provider === 'aws') return 'S3 bucket'
  if (provider === 'gcp') return 'Cloud Storage bucket'
  return 'blob container'
}

/**
 * The account a derived name is scoped to, asked of whichever cloud CLI or credential chain
 * already knows. Azure short-circuits: its name needs no identity, so it does not pay for a
 * lookup that could fail.
 */
export async function resolveScopeAccount(
  provider: CloudProvider,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (provider === 'azure') return undefined
  try {
    if (provider === 'aws') {
      const { callerAccount } = await import('./aws/preflight.js')
      return await callerAccount(signal)
    }
    const { resolveProjectId } = await import('./gcp/preflight.js')
    return resolveProjectId()
  } catch {
    // A missing credential is the ordinary case here, not an exception: the caller reports
    // what it could not derive and why, and carries on.
    return undefined
  }
}
