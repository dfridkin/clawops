// Auth profile management — resolves credentialsRef entries from ~/.clawops/config.json
// into concrete environment variable maps that providers can inject into their SDK clients.
// Per R6: no secrets are stored here; we reference env vars and CLI profile names only.

import { execSync } from 'node:child_process'
import type { CredentialsRef } from './store.js'

/**
 * Resolve a credentialsRef to a map of env var name → value.
 * Returns an empty object for sources that require no explicit env vars
 * (e.g. instance-metadata, which the SDK handles automatically).
 *
 * Throws if a required env var is missing.
 */
export function resolveCredentials(ref: CredentialsRef): Record<string, string> {
  switch (ref.source) {
    case 'env': {
      const result: Record<string, string> = {}
      for (const envVar of ref.envVars ?? []) {
        const val = process.env[envVar]
        if (val === undefined) {
          throw new Error(
            `Credentials env var "${envVar}" is not set. ` +
            `Configure it in your shell before running clawops.`,
          )
        }
        result[envVar] = val
      }
      return result
    }

    case 'cli-profile': {
      const profileName = ref.profileName
      if (!profileName) return {}
      // AWS: AWS_PROFILE; the SDK picks it up automatically once set.
      return { AWS_PROFILE: profileName }
    }

    case 'file':
      // gcloud ADC or GOOGLE_APPLICATION_CREDENTIALS — the SDK reads the file
      // referenced by that env var. We return the var name if it is already set.
      return process.env['GOOGLE_APPLICATION_CREDENTIALS']
        ? { GOOGLE_APPLICATION_CREDENTIALS: process.env['GOOGLE_APPLICATION_CREDENTIALS'] }
        : {}

    case 'instance-metadata':
      // IAM role / workload identity — no env vars needed; SDK fetches automatically.
      return {}

    default:
      return {}
  }
}

/**
 * Apply a credentialsRef to the current process.env so that subsequent SDK
 * calls pick up the right credentials without explicit configuration.
 * Call once per stack operation, before instantiating provider SDKs.
 */
export function applyCredentials(ref: CredentialsRef): void {
  const vars = resolveCredentials(ref)
  for (const [k, v] of Object.entries(vars)) {
    process.env[k] = v
  }
}

/**
 * Return true if the profile name is resolvable (i.e. the underlying CLI tool
 * knows about it). Uses `aws configure list-profiles` for AWS profiles.
 * Non-destructive — never mutates credentials.
 */
export function profileExists(profileName: string): boolean {
  try {
    const output = execSync('aws configure list-profiles 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return output.split('\n').map((l) => l.trim()).includes(profileName)
  } catch {
    return false
  }
}
