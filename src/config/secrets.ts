// $secret:<NAME> reference resolver for config overlays stored at
// ~/.clawops/secrets/<NAME> (written by `clawops secret set` / setup wizard).
// Per R6: the file contains the raw secret value; chmod 600.
//
// Distinct from src/plan/secrets.ts which resolves SecretRef objects declared
// in deploy plans. This module resolves inline $secret: refs in arbitrary
// config objects (e.g. openclaw.json overlays).

import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { getConfigDir } from './store.js'

const SECRET_REF_RE = /^\$secret:(.+)$/

/** Directory where `clawops secret set` writes secret files. */
export function secretsDir(configDir?: string): string {
  return path.join(configDir ?? getConfigDir(), 'secrets')
}

/**
 * Read a single named secret from the secrets directory.
 * Returns null if the file does not exist.
 */
export function resolveSecretRef(name: string, configDir?: string): string | null {
  const p = path.join(secretsDir(configDir), name)
  if (!existsSync(p)) return null
  try {
    return readFileSync(p, 'utf-8').trim()
  } catch {
    return null
  }
}

/**
 * Walk `value` recursively, replacing any string matching `$secret:<name>`
 * with the content of `~/.clawops/secrets/<name>`.
 *
 * - Unresolvable refs are left as-is; a warning is written to stderr.
 * - Arrays and plain objects are walked depth-first.
 * - Non-string scalars are returned unchanged.
 */
export function resolveSecretsInConfig<T>(value: T, configDir?: string): T {
  return walk(value, configDir ?? getConfigDir()) as T
}

function walk(value: unknown, configDir: string): unknown {
  if (typeof value === 'string') {
    const m = SECRET_REF_RE.exec(value)
    if (!m) return value
    const name = m[1]!
    const resolved = resolveSecretRef(name, configDir)
    if (resolved === null) {
      process.stderr.write(
        `[clawops] Warning: $secret:${name} could not be resolved ` +
        `(no file at ${path.join(secretsDir(configDir), name)}). ` +
        `Run \`clawops secret set ${name}\` to create it.\n`,
      )
      return value
    }
    return resolved
  }
  if (Array.isArray(value)) {
    return value.map((item) => walk(item, configDir))
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = walk(v, configDir)
    }
    return out
  }
  return value
}
