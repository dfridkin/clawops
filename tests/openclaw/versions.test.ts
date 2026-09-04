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

  it('refuses OpenClaw 2.0 — the defect this release fixes', () => {
    const r = checkVersion('2026.8.1', SUPPORT)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.reason).toBe('too-new')
    expect(r.error.message).toContain('clawops 2.x')
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
    const r = await assertSupportedVersion('latest', yaml, async () => '2026.8.1')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.requested).toBe('latest')
    expect(r.error.resolved).toBe('2026.8.1')
    expect(r.error.reason).toBe('too-new')
  })

  it('accepts a moving tag that resolves inside the range', async () => {
    const r = await assertSupportedVersion('stable', yaml, async () => '2026.7.1')
    expect(r.ok).toBe(true)
  })

  it('refuses when a moving tag cannot be resolved', async () => {
    const r = await assertSupportedVersion('latest', yaml)
    expect(r.ok).toBe(false)
  })
})

describe('spec/openclaw-versions.yaml', () => {
  it('is loadable and declares a bounded range on this line', () => {
    const spec = loadVersionSpec(yaml)
    expect(spec.support.min).toBeTruthy()
    // The v1.7.1 bug: an empty max silently accepted every future release.
    expect(spec.support.max, 'the 1.x line must declare an upper bound').not.toBe('')
  })

  it('excludes OpenClaw 2.0 from the shipped range', () => {
    const spec = loadVersionSpec(yaml)
    expect(checkVersion('2026.8.1', spec.support).ok).toBe(false)
    expect(checkVersion('2026.9.1', spec.support).ok).toBe(false)
  })

  it('still admits the last pre-2.0 release', () => {
    const spec = loadVersionSpec(yaml)
    expect(checkVersion('2026.7.1-2', spec.support).ok).toBe(true)
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
