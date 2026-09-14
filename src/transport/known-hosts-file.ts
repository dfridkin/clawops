// Reading and rewriting the known_hosts file itself.
//
// `known-hosts.ts` is pure string handling so it can be tested without a filesystem; this is
// the thin layer that touches disk, kept separate for the same reason.

import { readFileSync, writeFileSync } from 'node:fs'
import { withoutHost } from './known-hosts.js'

/**
 * Drop every entry for a host. Returns whether anything changed.
 *
 * A missing or unreadable file is not an error: there is then nothing pinned, which is the
 * state the caller wanted.
 */
export function forgetHost(knownHostsPath: string, host: string, port: number): boolean {
  let content: string
  try {
    content = readFileSync(knownHostsPath, 'utf-8')
  } catch {
    return false
  }

  const next = withoutHost(content, host, port)
  if (next === content) return false

  writeFileSync(knownHostsPath, next, 'utf-8')
  return true
}
