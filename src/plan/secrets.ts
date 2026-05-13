// $secret: reference resolver for deploy plans.
// Walks a config object and replaces "$secret:<name>" strings with resolved values.
// Secret sources: env (sync), file (sync). Cloud SM sources (aws-sm, gcp-sm, azure-kv)
// are declared in plans but not yet resolved — a warning is emitted and the ref is kept.

import { readFileSync } from 'node:fs'

export interface SecretRef {
  name: string
  source: 'env' | 'aws-sm' | 'aws-ssm' | 'gcp-sm' | 'azure-kv' | 'file'
  ref?: string
}

const UNRESOLVED_SOURCES = new Set(['aws-sm', 'aws-ssm', 'gcp-sm', 'azure-kv'])

/**
 * Resolve all $secret:<name> references in `config` using the `secrets` map.
 * Returns a new object — does not mutate the input.
 * Emits a warning to stderr for unsupported cloud SM sources and leaves the
 * $secret: ref in place so the caller can see which ones need manual handling.
 */
export function resolveSecrets(
  config: Record<string, unknown>,
  secrets: SecretRef[],
): Record<string, unknown> {
  const resolved = buildSecretMap(secrets)
  return walkResolve(config, resolved) as Record<string, unknown>
}

function buildSecretMap(secrets: SecretRef[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const secret of secrets) {
    if (UNRESOLVED_SOURCES.has(secret.source)) {
      process.stderr.write(
        `[clawops] Warning: secret "${secret.name}" uses source "${secret.source}" ` +
        `which is not yet resolved automatically. Set the value manually after deployment ` +
        `with: clawops config set\n`,
      )
      continue
    }

    if (secret.source === 'env') {
      const ref = secret.ref ?? secret.name
      const val = process.env[ref]
      if (val === undefined) {
        process.stderr.write(
          `[clawops] Warning: secret "${secret.name}" references env var "${ref}" which is not set. ` +
          `The $secret: ref will remain unresolved in the config.\n`,
        )
        continue
      }
      map.set(secret.name, val)
    } else if (secret.source === 'file') {
      if (!secret.ref) {
        process.stderr.write(
          `[clawops] Warning: secret "${secret.name}" has source "file" but no ref path.\n`,
        )
        continue
      }
      try {
        map.set(secret.name, readFileSync(secret.ref, 'utf-8').trim())
      } catch (err) {
        process.stderr.write(
          `[clawops] Warning: cannot read secret "${secret.name}" from file "${secret.ref}": ` +
          `${(err as Error).message}\n`,
        )
      }
    }
  }
  return map
}

function walkResolve(value: unknown, secrets: Map<string, string>): unknown {
  if (typeof value === 'string') {
    const match = /^\$secret:(.+)$/.exec(value)
    if (match) {
      const name = match[1]!
      const resolved = secrets.get(name)
      if (resolved !== undefined) return resolved
      // Leave unresolvable refs in place — caller will see them
      return value
    }
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item) => walkResolve(item, secrets))
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = walkResolve(v, secrets)
    }
    return result
  }
  return value
}
