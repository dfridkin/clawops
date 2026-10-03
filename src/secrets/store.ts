// The locally stored secrets under ~/.clawops/secrets/: listing them, auditing the references
// stacks make to them, and deleting one.
//
// This lives outside the CLI command because the MCP server runs the same operations, and an
// agent must get the same answers, warnings and refusals an operator does. Nothing here prints:
// every function returns data and the caller decides how to render it (R15 forbids a stdio
// server writing to stdout, so `src/output/human.js` is never imported here).
//
// Nothing here returns a secret's value. Listing and auditing read a file only to learn whether
// it is empty; the content never leaves the function that read it (R6).

import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import process from 'node:process'
import { listOverlays } from '../plan/overlay-store.js'

/** Where `clawops secret set` writes secret files. */
export function secretsDir(): string {
  return path.join(os.homedir(), '.clawops', 'secrets')
}

export type SecretPathResult =
  | { ok: true; path: string }
  | { ok: false; reason: string }

/**
 * The file a secret name refers to, or a refusal when the name would point anywhere else.
 *
 * A name is one file name inside the secrets directory. `../x`, `a/b`, `.` and `..` are refused:
 * joined onto the directory they would read, overwrite or delete a file outside it.
 */
export function resolveSecretPath(name: string): SecretPathResult {
  const dir = secretsDir()
  const invalid =
    name.length === 0 ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0') ||
    path.dirname(path.resolve(dir, name)) !== path.resolve(dir)
  if (invalid) {
    return {
      ok: false,
      reason:
        `Secret name "${name}" is not valid: a secret name is a single file name inside ${dir} ` +
        '(no "/" or "\\", and not "." or "..").',
    }
  }
  return { ok: true, path: path.join(dir, name) }
}

export function listSecretNames(): string[] {
  if (!existsSync(secretsDir())) return []
  return readdirSync(secretsDir()).filter((f) => !f.startsWith('.'))
}

// ── list ───────────────────────────────────────────────────────────────────

export interface SecretListing {
  name: string
  status: 'ok' | 'empty' | 'unreadable'
  source: 'file'
  path: string
  modified: string
  resolvable: boolean
}

/** Every stored secret by name and status. Never includes a value. */
export function listSecrets(): SecretListing[] {
  return listSecretNames().map((name) => {
    const p = path.join(secretsDir(), name)
    try {
      const stat = statSync(p)
      const nonEmpty = readFileSync(p, 'utf-8').trim().length > 0
      const modified = stat.mtime.toISOString().slice(0, 10)
      return { name, status: nonEmpty ? 'ok' : 'empty', source: 'file', path: p, modified, resolvable: nonEmpty }
    } catch {
      return { name, status: 'unreadable', source: 'file', path: p, modified: '—', resolvable: false }
    }
  })
}

export const NO_SECRETS_MESSAGE = 'No secrets stored in ~/.clawops/secrets/'
export const SET_SECRET_HINT = 'Run `clawops secret set <name>` to add one.'

// ── audit ──────────────────────────────────────────────────────────────────

export interface SecretIssue {
  kind: 'empty-secret' | 'unreadable-secret' | 'missing-file' | 'missing-env' | 'cloud-sm-unresolved'
  stack?: string
  secret: string
  detail: string
}

export interface SecretAuditReport {
  issues: SecretIssue[]
  ok: boolean
}

/**
 * Stored secrets that are empty or unreadable, and `$secret:` references in stored stack
 * overlays that cannot be resolved. Details name files and env vars, never their contents.
 */
export function auditSecrets(): SecretAuditReport {
  const issues: SecretIssue[] = []

  // 1. Every known secret file is readable and non-empty
  for (const name of listSecretNames()) {
    const p = path.join(secretsDir(), name)
    try {
      if (readFileSync(p, 'utf-8').trim().length === 0) {
        issues.push({ kind: 'empty-secret', secret: name, detail: `File exists but is empty: ${p}` })
      }
    } catch {
      issues.push({ kind: 'unreadable-secret', secret: name, detail: `Cannot read: ${p}` })
    }
  }

  // 2. Every overlay's secret refs are resolvable
  for (const overlay of listOverlays()) {
    for (const s of overlay.secrets) {
      if (s.source === 'file') {
        const ref = s.ref ?? path.join(secretsDir(), s.name)
        if (!existsSync(ref)) {
          issues.push({ kind: 'missing-file', stack: overlay.stackName, secret: s.name, detail: `File not found: ${ref}` })
        }
      } else if (s.source === 'env') {
        const envVar = s.ref ?? s.name
        if (!process.env[envVar]) {
          issues.push({ kind: 'missing-env', stack: overlay.stackName, secret: s.name, detail: `Env var not set: ${envVar}` })
        }
      } else {
        issues.push({ kind: 'cloud-sm-unresolved', stack: overlay.stackName, secret: s.name, detail: `Source "${s.source}" is not auto-resolved — set manually` })
      }
    }
  }

  return { issues, ok: issues.length === 0 }
}

export const AUDIT_CLEAN_MESSAGE = 'All secrets are resolvable. No issues found.'
export const AUDIT_FIX_HINT = 'Run `clawops secret set <name>` to update a missing or empty secret.'

export function auditIssuesHeadline(count: number): string {
  return `${count} issue${count === 1 ? '' : 's'} found:`
}

export function formatAuditIssue(issue: SecretIssue): string {
  const prefix = issue.stack ? `[${issue.stack}] ` : ''
  return `${prefix}${issue.secret}: ${issue.detail}`
}

// ── delete ─────────────────────────────────────────────────────────────────

export type SecretDeletePreparation =
  | { ok: false; kind: 'invalid-name' | 'not-found'; reason: string }
  | { ok: true; name: string; path: string; referencingStacks: string[]; warnings: string[] }

/**
 * Everything decided before a delete: whether the name is valid, whether the secret exists, and
 * which stacks still reference it. Nothing is deleted here, so the caller can show the warnings
 * before it asks for confirmation.
 */
export function prepareSecretDelete(name: string): SecretDeletePreparation {
  const resolved = resolveSecretPath(name)
  if (!resolved.ok) return { ok: false, kind: 'invalid-name', reason: resolved.reason }

  const p = resolved.path
  if (!existsSync(p)) {
    return { ok: false, kind: 'not-found', reason: `Secret "${name}" not found at ${p}` }
  }

  const referencingStacks = listOverlays()
    .filter((o) => o.secrets.some((s) => s.name === name))
    .map((o) => o.stackName)

  const warnings =
    referencingStacks.length > 0
      ? [
          `Secret "${name}" is referenced by stack(s): ${referencingStacks.join(', ')}`,
          'Deleting it will leave those stacks with an unresolvable $secret: ref.',
        ]
      : []

  return { ok: true, name, path: p, referencingStacks, warnings }
}

export function deleteConfirmQuestion(name: string): string {
  return `Delete secret "${name}"?`
}

/** Delete a secret that `prepareSecretDelete` accepted. Returns the success message. */
export function deletePreparedSecret(prepared: { name: string; path: string }): string {
  unlinkSync(prepared.path)
  return `Secret "${prepared.name}" deleted.`
}
