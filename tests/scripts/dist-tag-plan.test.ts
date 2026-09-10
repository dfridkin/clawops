import { describe, it, expect } from 'vitest'
// @ts-expect-error — plain ESM helper shared with the release shell script
import { planDistTags, majorOf } from '../../scripts/lib/dist-tag-plan.mjs'

// v1.7.8 published as `legacy: 1.7.8` while `latest` stayed on 1.7.7, so the release that
// added authentication to the MCP HTTP server was not what `npm install -g @clawops/cli`
// served. The `legacy`-only rule is right once 2.x has shipped and wrong before it has.

describe('planDistTags', () => {
  it('leaves main on the changesets default', () => {
    const plan = planDistTags({ branch: 'main', version: '2.0.0', currentLatest: '1.7.8' })
    expect(plan.publishTag).toBeUndefined()
    expect(plan.alsoTag).toEqual([])
  })

  it('leaves main on the default even once `latest` is 2.x', () => {
    // The case where the two branches actually differ. Pre-2.0 they agree — both take
    // `latest` — so a test using only that case cannot tell whether the branch is being
    // read at all, and a 2.1.0 release from main would silently publish under `legacy`.
    const plan = planDistTags({ branch: 'main', version: '2.1.0', currentLatest: '2.0.0' })
    expect(plan.publishTag).toBeUndefined()
    expect(planDistTags({ branch: '1.x', version: '1.7.9', currentLatest: '2.0.0' }).publishTag)
      .toBe('legacy')
  })

  it('publishes a 1.x release straight to `latest` while `latest` is still 1.x', () => {
    // Not "legacy plus a second tag": only the publish call is authenticated. npm's trusted
    // publishing leaves no credentials behind, so a follow-up `npm dist-tag add` returns
    // E401 — measured on the 1.7.9 release, which published and then failed to move `latest`.
    const plan = planDistTags({ branch: '1.x', version: '1.7.9', currentLatest: '1.7.8' })
    expect(plan.publishTag).toBeUndefined()
    expect(plan.alsoTag).toEqual([])
  })

  it('is the 1.7.8 case: same major, newer patch, must reach a fresh install', () => {
    // The comparison was `>=` first, which read "same line" as "newer line" and reproduced
    // exactly the bug it was written to prevent.
    const plan = planDistTags({ branch: '1.x', version: '1.7.8', currentLatest: '1.7.7' })
    expect(plan.publishTag).toBeUndefined()
  })

  it('never asks for a tag it cannot authenticate', () => {
    // Any non-empty alsoTag would fail the release job with E401 after a successful publish.
    for (const currentLatest of ['1.7.8', '2.0.0', undefined, 'nonsense']) {
      for (const branch of ['1.x', 'main']) {
        expect(planDistTags({ branch, version: '1.7.9', currentLatest }).alsoTag).toEqual([])
      }
    }
  })

  it('never lets 1.x take `latest` back once 2.x has shipped', () => {
    for (const currentLatest of ['2.0.0', '2.1.3', '10.0.0']) {
      const plan = planDistTags({ branch: '1.x', version: '1.7.9', currentLatest })
      expect(plan.publishTag).toBe('legacy')
      expect(plan.alsoTag, `latest is ${currentLatest}`).toEqual([])
    }
  })

  it('still publishes under legacy when `latest` cannot be read', () => {
    // A network failure must not decide a dist-tag. Leaving `latest` alone is recoverable;
    // moving it on a guess is not.
    for (const currentLatest of [undefined, '', 'null', 'not-a-version']) {
      const plan = planDistTags({ branch: '1.x', version: '1.7.9', currentLatest })
      expect(plan.publishTag).toBe('legacy')
      expect(plan.alsoTag).toEqual([])
    }
  })

  it('explains itself, so the release log says why', () => {
    expect(planDistTags({ branch: '1.x', version: '1.7.9', currentLatest: '1.7.8' }).reason)
      .toMatch(/fresh install/)
    expect(planDistTags({ branch: '1.x', version: '1.7.9', currentLatest: '2.0.0' }).reason)
      .toMatch(/newer line/)
  })
})

describe('majorOf', () => {
  it.each([['1.7.8', 1], ['2.0.0', 2], ['10.2.3', 10], ['1.7.1-2', 1]])(
    'reads %s as major %i',
    (v, expected) => expect(majorOf(v)).toBe(expected),
  )

  it.each([undefined, '', 'latest', 'v1', 'x.y.z'])('returns undefined for %s', (v) => {
    expect(majorOf(v)).toBeUndefined()
  })
})
