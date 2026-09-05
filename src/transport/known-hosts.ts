// OpenSSH known_hosts parsing and host-key verification.
//
// Replaces a verifier that read `parts[1]` of each line as the key. In OpenSSH format
// that field is the key *type* (`ssh-ed25519`), not the key, so any standard entry
// failed to match — permanently, with "Host denied (verification failed)". It only ever
// worked against clawops's own two-field hex format in its own private file, and would
// corrupt ~/.ssh/known_hosts if pointed at one.
//
// Supported entry forms:
//   host key-type base64-key                 standard
//   host1,host2 key-type base64-key          comma-separated host list
//   [host]:port key-type base64-key          non-default port
//   |1|salt|hash key-type base64-key         hashed hostname (HMAC-SHA1)
//   @revoked host key-type base64-key        marker-prefixed
//   *.example.com key-type base64-key        wildcard pattern
//   !secure.example,*.example key-type key    negated pattern
//   host <hex>                               legacy clawops format, still read
//
// Wildcards are honoured because ignoring them is the less safe option, not the safer
// one: an unmatched wildcard falls through to trust-on-first-use, which *accepts* a key
// the user's own file contradicts and then records it. Matching the wildcard turns that
// case into the refusal it should be.

import { createHmac, timingSafeEqual } from 'node:crypto'

export type HostKeyVerdict = 'match' | 'mismatch' | 'unknown'

export interface KnownHostsEntry {
  /** Host patterns, or the raw `|1|salt|hash` token for a hashed entry. */
  hosts: string[]
  /** `ssh-ed25519`, `ssh-rsa`, … Absent for legacy clawops entries. */
  keyType?: string
  /** Base64 key as written by OpenSSH. */
  base64Key?: string
  /** Hex key, for legacy clawops-written entries. */
  hexKey?: string
  /** `@revoked` / `@cert-authority`, when present. */
  marker?: string
}

/** Format a host for lookup: bare when on port 22, `[host]:port` otherwise. */
export function hostEntryFor(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`
}

export function parseKnownHosts(content: string): KnownHostsEntry[] {
  const entries: KnownHostsEntry[] = []
  for (const raw of content.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue

    let parts = line.split(/\s+/)
    let marker: string | undefined
    if (parts[0]?.startsWith('@')) {
      marker = parts[0]
      parts = parts.slice(1)
    }

    const hostField = parts[0]
    if (!hostField) continue
    const hosts = hostField.split(',')

    if (parts.length >= 3) {
      entries.push({ hosts, keyType: parts[1], base64Key: parts[2], ...(marker ? { marker } : {}) })
    } else if (parts.length === 2 && /^[0-9a-f]+$/i.test(parts[1] ?? '')) {
      // Legacy clawops format: `<host> <hex>`. Kept so existing installs keep working.
      entries.push({ hosts, hexKey: parts[1], ...(marker ? { marker } : {}) })
    }
  }
  return entries
}

/** Does a hashed `|1|salt|hash` token match this host entry? */
function hashedHostMatches(token: string, hostEntry: string): boolean {
  const parts = token.split('|')
  // ['', '1', salt, hash]
  if (parts.length !== 4 || parts[1] !== '1') return false
  const salt = parts[2]
  const expected = parts[3]
  if (!salt || !expected) return false
  try {
    const actual = createHmac('sha1', Buffer.from(salt, 'base64'))
      .update(hostEntry)
      .digest('base64')
    const a = Buffer.from(actual)
    const b = Buffer.from(expected)
    return a.length === b.length && timingSafeEqual(a, b)
  } catch {
    return false
  }
}

/**
 * Translate an OpenSSH host pattern to a RegExp.
 *
 * `*` matches any run of characters (dots included) and `?` exactly one, per
 * ssh_config(5) PATTERNS. Regex metacharacters are escaped first — `[host]:2222`
 * must be treated as literal brackets, not a character class. Matching is
 * case-insensitive because OpenSSH lowercases hostnames before comparing.
 */
function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i')
}

const isPattern = (host: string): boolean => host.includes('*') || host.includes('?')

/**
 * Does this entry's host list cover `hostEntry`?
 *
 * A negated pattern (`!host`) voids the entry outright, regardless of any other
 * pattern in the same list — that is how an operator excludes one host from a
 * subdomain wildcard, so honouring `*` without `!` would trust a host they
 * explicitly excluded.
 */
function entryMatchesHost(entry: KnownHostsEntry, hostEntry: string): boolean {
  let matched = false
  for (const host of entry.hosts) {
    if (host.startsWith('|1|')) {
      // Hashed entries are exact by construction; they are never patterns.
      if (hashedHostMatches(host, hostEntry)) matched = true
      continue
    }
    const negated = host.startsWith('!')
    const pattern = negated ? host.slice(1) : host
    const hit = isPattern(pattern)
      ? patternToRegExp(pattern).test(hostEntry)
      : pattern === hostEntry
    if (hit) {
      if (negated) return false
      matched = true
    }
  }
  return matched
}

/**
 * Compare a presented key against known_hosts.
 *
 * `mismatch` means a key is on file for this host and differs — a hard failure, since
 * that is what host-key verification exists to catch. `unknown` means no entry, which
 * the caller resolves under its own trust-on-first-use policy.
 *
 * `@revoked` entries always produce `mismatch`.
 */
export function verifyAgainstKnownHosts(
  content: string,
  host: string,
  port: number,
  key: Buffer,
): HostKeyVerdict {
  const hostEntry = hostEntryFor(host, port)
  const base64Key = key.toString('base64')
  const hexKey = key.toString('hex')

  let sawHost = false
  for (const entry of parseKnownHosts(content)) {
    if (!entryMatchesHost(entry, hostEntry)) continue
    if (entry.marker === '@cert-authority') continue // CA entries are not host keys
    sawHost = true
    const matches = entry.base64Key
      ? entry.base64Key === base64Key
      : entry.hexKey?.toLowerCase() === hexKey.toLowerCase()
    if (matches) return entry.marker === '@revoked' ? 'mismatch' : 'match'
  }

  return sawHost ? 'mismatch' : 'unknown'
}

/**
 * Render a standard OpenSSH known_hosts line.
 *
 * Standard format specifically: clawops's private file may be pointed at
 * ~/.ssh/known_hosts, and a two-field hex line there is unparseable by ssh itself.
 */
export function formatKnownHostsLine(host: string, port: number, keyType: string, key: Buffer): string {
  return `${hostEntryFor(host, port)} ${keyType} ${key.toString('base64')}\n`
}

/**
 * Read the key type out of an SSH public-key blob.
 *
 * Wire format is a length-prefixed string: 4-byte big-endian length, then the type.
 */
export function keyTypeFromBlob(key: Buffer): string | undefined {
  if (key.length < 4) return undefined
  const len = key.readUInt32BE(0)
  if (len === 0 || len > 64 || key.length < 4 + len) return undefined
  const type = key.subarray(4, 4 + len).toString('utf-8')
  return /^[\x20-\x7e]+$/.test(type) ? type : undefined
}
