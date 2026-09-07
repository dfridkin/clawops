// npm refuses a dist-tag that parses as a SemVer range, so the maintenance line cannot
// be published under the obvious name. `npm dist-tag add @clawops/cli@1.7.7 v1` fails
// with "Tag name must not be a valid SemVer range: v1" — and `v1.x` and `1.x` are the
// same range (`>=1.0.0 <2.0.0-0`).
//
// The failure surfaces only at publish time, on the maintenance line, which is the
// least-exercised path in the project. Hence a test.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const workflow = readFileSync(
  resolve(import.meta.dirname, '../../.github/workflows/release.yml'),
  'utf8',
)

/** Tag names npm rejects because they parse as a version or a range. */
function parsesAsSemver(tag: string): boolean {
  return /^[v=]?\s*\d/.test(tag.trim()) || /^[v=]?\s*\d+(\.\d+)*\.?x/.test(tag.trim())
}

describe('release dist-tag', () => {
  it('the maintenance line publishes under a tag npm will accept', () => {
    const match = workflow.match(/ci-publish\.sh \$\{\{[^}]*&&\s*'([^']+)'/)
    expect(match, 'could not find the dist-tag expression in release.yml').not.toBeNull()

    const tag = match![1]!
    expect(parsesAsSemver(tag), `npm rejects the dist-tag "${tag}": it parses as a SemVer range`)
      .toBe(false)
  })

  it('rejects the names that actually failed', () => {
    // Guards the guard: these are the three npm turned down.
    for (const bad of ['v1', 'v1.x', '1.x']) expect(parsesAsSemver(bad), bad).toBe(true)
    for (const good of ['legacy', 'lts', 'maintenance']) expect(parsesAsSemver(good), good).toBe(false)
  })

  it('only the maintenance branch gets a tag; main keeps the default', () => {
    expect(workflow).toMatch(/github\.ref_name == '1\.x'/)
    expect(workflow).toMatch(/&&\s*'legacy'\s*\|\|\s*''/)
  })
})
