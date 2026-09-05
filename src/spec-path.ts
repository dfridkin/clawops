// Locate the `spec/` directory at runtime.
//
// The layout differs between source and bundle: from src/openclaw/ the spec dir is two
// levels up, from the tsup output in dist/ it is one. Hard-coded relative paths work in
// exactly one of those, which is why `clawops plan` could not load its own schema from a
// built artifact before v1.7.2 — it resolved to <repo-parent>/spec and threw ENOENT.
//
// Walking up for a known marker file is correct in both layouts and survives a change to
// the bundle's depth.

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, parse } from 'node:path'

/** A file that must exist inside spec/, used to confirm we found the right directory. */
const MARKER = 'openclaw-versions.yaml'

let _cached: string | undefined

/**
 * Walk up from `startUrl` (default: this module) looking for a `spec/` directory.
 * Throws with the searched path rather than returning a guess, so a packaging mistake
 * fails loudly instead of surfacing as a confusing ENOENT deeper in a command.
 */
export function resolveSpecDir(startUrl: string = import.meta.url): string {
  if (_cached) return _cached
  let dir = dirname(fileURLToPath(startUrl))
  const { root } = parse(dir)
  while (true) {
    const candidate = join(dir, 'spec')
    if (existsSync(join(candidate, MARKER))) {
      _cached = candidate
      return candidate
    }
    if (dir === root) break
    dir = dirname(dir)
  }
  throw new Error(
    `Cannot locate the spec/ directory (searched upward from ${dirname(fileURLToPath(startUrl))}). ` +
      'If this is an installed package, spec/ may be missing from the published files.',
  )
}

/** Reset the cache. Tests only. */
export function _resetSpecDirCache(): void {
  _cached = undefined
}
