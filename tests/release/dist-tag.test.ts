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
// @ts-expect-error — plain ESM helper shared with the release shell script
import { planDistTags } from '../../scripts/lib/dist-tag-plan.mjs'

const workflow = readFileSync(
  resolve(import.meta.dirname, '../../.github/workflows/release.yml'),
  'utf8',
)

/** Tag names npm rejects because they parse as a version or a range. */
function parsesAsSemver(tag: string): boolean {
  return /^[v=]?\s*\d/.test(tag.trim()) || /^[v=]?\s*\d+(\.\d+)*\.?x/.test(tag.trim())
}

describe('release dist-tag', () => {
  it('every tag the plan can emit is one npm will accept', () => {
    // The decision moved out of the workflow expression and into dist-tag-plan.mjs, so this
    // asks the planner rather than grepping YAML for a literal.
    const cases = [
      { branch: '1.x', version: '1.7.9', currentLatest: '1.7.8' },
      { branch: '1.x', version: '1.7.9', currentLatest: '2.0.0' },
      { branch: '1.x', version: '1.7.9', currentLatest: undefined },
      { branch: 'main', version: '2.0.0', currentLatest: '1.7.8' },
    ]
    for (const c of cases) {
      const plan = planDistTags(c)
      for (const tag of [plan.publishTag, ...plan.alsoTag].filter(Boolean) as string[]) {
        expect(parsesAsSemver(tag), `npm rejects the dist-tag "${tag}": it parses as a SemVer range`)
          .toBe(false)
      }
    }
  })

  it('rejects the names that actually failed', () => {
    // Guards the guard: these are the three npm turned down.
    for (const bad of ['v1', 'v1.x', '1.x']) expect(parsesAsSemver(bad), bad).toBe(true)
    for (const good of ['legacy', 'lts', 'maintenance']) expect(parsesAsSemver(good), good).toBe(false)
  })

  it('only the maintenance branch gets a tag; main keeps the default', () => {
    expect(planDistTags({ branch: 'main', version: '2.0.0', currentLatest: '1.7.8' }).publishTag)
      .toBeUndefined()
    expect(planDistTags({ branch: '1.x', version: '1.7.9', currentLatest: '2.0.0' }).publishTag)
      .toBe('legacy')
    // Pre-2.0 the 1.x line takes `latest` itself, because only the publish call can
    // authenticate and `latest` is the tag every default install reads.
    expect(planDistTags({ branch: '1.x', version: '1.7.9', currentLatest: '1.7.8' }).publishTag)
      .toBeUndefined()
  })

  it('the workflow hands the planner a branch, not a pre-decided tag', () => {
    // If this reverts to an inline `&& 'legacy' || ''`, the plan stops being consulted and
    // 1.7.8's mistake — `legacy` moved, `latest` left behind — comes back.
    expect(workflow).toMatch(/ci-publish\.sh \$\{\{\s*github\.ref_name\s*\}\}/)
    expect(workflow).not.toMatch(/ci-publish\.sh \$\{\{[^}]*&&\s*'legacy'/)
  })

  it('the publish script consults the plan and fails loudly if a tag cannot be set', () => {
    const script = readFileSync(
      resolve(import.meta.dirname, '../../scripts/ci-publish.sh'),
      'utf8',
    )
    expect(script).toContain('dist-tag-plan.mjs')
    expect(script).toContain('npm dist-tag add')
    // No `|| true` on the tag move: a release that publishes but leaves `latest` behind
    // looks shipped while every fresh install keeps getting the old version.
    expect(script).not.toMatch(/npm dist-tag add[^\n]*\|\|\s*true/)
  })
})
