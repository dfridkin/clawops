// Version-range enforcement (v1.7.2). Regression cover for the gap that let
// clawops v1.7.x accept OpenClaw 2.0: `support.max` was unbounded AND unread.

import { describe, it, expect, beforeEach } from 'vitest'
import * as yaml from 'js-yaml'
import {
  compareVersions,
  checkVersion,
  resolveVersion,
  assertSupportedVersion,
  loadVersionSpec,
  isMovingTag,
  describeRange,
  _resetVersionSpecCache,
  type VersionSupport,
} from '../../src/openclaw/versions.js'

const SUPPORT: VersionSupport = {
  min: '2026.4.5',
  max: '2026.7.1-2',
  recommended: '2026.7.1-2',
}

beforeEach(() => _resetVersionSpecCache())

describe('compareVersions', () => {
  it('orders date-style versions numerically, not lexicographically', () => {
    // The bug a string compare would introduce: "2026.10.1" < "2026.9.1".
    expect(compareVersions('2026.10.1', '2026.9.1')).toBeGreaterThan(0)
    expect(compareVersions('2026.9.1', '2026.10.1')).toBeLessThan(0)
  })

  it('treats equal versions as equal', () => {
    expect(compareVersions('2026.8.1', '2026.8.1')).toBe(0)
  })

  it('handles the -N patch suffix', () => {
    expect(compareVersions('2026.7.1-2', '2026.7.1')).toBeGreaterThan(0)
    expect(compareVersions('2026.7.1', '2026.7.1-2')).toBeLessThan(0)
    expect(compareVersions('2026.7.1-2', '2026.7.1-1')).toBeGreaterThan(0)
  })

  it('treats a missing segment as zero', () => {
    expect(compareVersions('2026.8', '2026.8.0')).toBe(0)
  })
})

describe('checkVersion', () => {
  it('accepts a version inside the range', () => {
    const r = checkVersion('2026.6.34', SUPPORT)
    expect(r.ok).toBe(true)
  })

  it('accepts both boundaries inclusively', () => {
    expect(checkVersion('2026.4.5', SUPPORT).ok).toBe(true)
    expect(checkVersion('2026.7.1-2', SUPPORT).ok).toBe(true)
  })

  it('refuses a version above a declared ceiling', () => {
    // SUPPORT is a local fixture with an upper bound. The shipped 2.x spec has none, so
    // this branch is unreachable there — but it must stay correct for any future line
    // that reintroduces a ceiling, and must not advertise "use clawops 2.x", which is
    // where we already are.
    const r = checkVersion('2026.8.1', SUPPORT)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.reason).toBe('too-new')
    expect(r.error.message).toContain('at or below')
    expect(r.error.message).not.toContain('clawops 2.x')
  })

  it('refuses anything newer than 2.0 too', () => {
    expect(checkVersion('2026.9.1', SUPPORT).ok).toBe(false)
    expect(checkVersion('2026.12.1', SUPPORT).ok).toBe(false)
  })

  it('refuses versions below the floor', () => {
    const r = checkVersion('2026.1.1', SUPPORT)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.reason).toBe('too-old')
  })

  it('refuses an unresolved moving tag rather than assuming it is safe', () => {
    // Failing closed matters: a moving tag is exactly how 2.0 reaches a deployment.
    for (const tag of ['latest', 'stable', 'dev', 'main']) {
      const r = checkVersion(tag, SUPPORT)
      expect(r.ok, `${tag} must not pass unresolved`).toBe(false)
    }
  })

  it('treats an empty max as unbounded above', () => {
    const unbounded: VersionSupport = { ...SUPPORT, max: '' }
    expect(checkVersion('2026.8.1', unbounded).ok).toBe(true)
    // ...which is precisely the shipped v1.7.1 behaviour this release ends.
  })
})

describe('resolveVersion', () => {
  it('passes concrete versions through untouched', async () => {
    expect(await resolveVersion('2026.7.1')).toBe('2026.7.1')
  })

  it('resolves a moving tag via the supplied resolver', async () => {
    expect(await resolveVersion('latest', async () => '2026.8.1')).toBe('2026.8.1')
  })

  it('returns the tag unchanged when no resolver is available', async () => {
    expect(await resolveVersion('latest')).toBe('latest')
  })

  it('returns the tag unchanged when the resolver throws', async () => {
    const boom = async () => {
      throw new Error('registry unreachable')
    }
    expect(await resolveVersion('latest', boom)).toBe('latest')
  })
})

describe('assertSupportedVersion — resolution order', () => {
  it('resolves BEFORE range-checking', async () => {
    // Order is the whole point: checking first and resolving after is how an
    // unbounded ceiling went unnoticed. `latest` now points at 2.0.
    // A moving tag resolving BELOW the floor is the 2.x version of this hazard: the tag
    // says nothing, the resolved version is what the runtime has to honour.
    const r = await assertSupportedVersion('latest', yaml, async () => '2026.7.1-2')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.requested).toBe('latest')
    expect(r.error.resolved).toBe('2026.7.1-2')
    expect(r.error.reason).toBe('too-old')
  })

  it('accepts a moving tag that resolves inside the range', async () => {
    const r = await assertSupportedVersion('stable', yaml, async () => '2026.9.2')
    expect(r.ok).toBe(true)
  })

  it('refuses when a moving tag cannot be resolved', async () => {
    const r = await assertSupportedVersion('latest', yaml)
    expect(r.ok).toBe(false)
  })
})

describe('spec/openclaw-versions.yaml', () => {
  it('declares a floor, and no ceiling on this line', () => {
    const spec = loadVersionSpec(yaml)
    expect(spec.support.min).toBeTruthy()
    // Inverted with the 2.x flip. On 1.x an empty max was the v1.7.1 bug — it silently
    // accepted every future release including 2.0. On 2.x it is correct: this line tracks
    // the 2.x runtime contract and has no known upper bound. The 1.x branch keeps the
    // bounded-range assertion, which is where it still means something.
    expect(spec.support.max, 'the 2.x line tracks forward and declares no ceiling').toBe('')
  })

  it('accepts the 2.0 runtime it was built for', () => {
    const spec = loadVersionSpec(yaml)
    expect(checkVersion('2026.9.2', spec.support).ok).toBe(true)
    expect(checkVersion('2026.12.1', spec.support).ok).toBe(true)
  })

  it('refuses the 1.x runtime it can no longer deploy correctly', () => {
    // The mirror of the 1.x guard. This line mounts a writable state directory, writes
    // gateway.mode and drops --allow-unconfigured — none of which a pre-2.0 OpenClaw
    // understands. Deploying one from here would be the same class of failure the guard
    // was written to prevent, in the other direction.
    const spec = loadVersionSpec(yaml)
    expect(checkVersion('2026.7.1-2', spec.support).ok).toBe(false)
    expect(checkVersion('2026.4.5', spec.support).ok).toBe(false)
  })

  it('admits the floor it was built against', () => {
    const spec = loadVersionSpec(yaml)
    expect(checkVersion('2026.9.2', spec.support).ok).toBe(true)
  })
})

describe('helpers', () => {
  it('identifies moving tags', () => {
    expect(isMovingTag('latest')).toBe(true)
    expect(isMovingTag('2026.8.1')).toBe(false)
  })

  it('describes bounded and unbounded ranges', () => {
    expect(describeRange(SUPPORT)).toBe('2026.4.5 – 2026.7.1-2')
    expect(describeRange({ ...SUPPORT, max: '' })).toBe('>= 2026.4.5')
  })
})
