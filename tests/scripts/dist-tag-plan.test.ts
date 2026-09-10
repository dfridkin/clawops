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

  it('gives a 1.x release `latest` too, while `latest` is still 1.x', () => {
    const plan = planDistTags({ branch: '1.x', version: '1.7.9', currentLatest: '1.7.8' })
    expect(plan.publishTag).toBe('legacy')
    expect(plan.alsoTag).toEqual(['latest'])
  })

  it('is the 1.7.8 case: same major, newer patch, must take latest', () => {
    // The comparison was `>=` first, which read "same line" as "newer line" and reproduced
    // exactly the bug it was written to prevent.
    const plan = planDistTags({ branch: '1.x', version: '1.7.8', currentLatest: '1.7.7' })
    expect(plan.alsoTag).toEqual(['latest'])
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
