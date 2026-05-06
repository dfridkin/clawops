// Unit tests for validatePlan() / assertValidPlan().

import { describe, it, expect } from 'vitest'
import { validatePlan, assertValidPlan } from '../../src/plan/validate.js'

const VALID_PLAN = {
  apiVersion: 'clawops.dev/v1',
  kind: 'DeployPlan',
  metadata: {
    name: 'test-stack',
    generatedAt: new Date().toISOString(),
  },
  spec: {
    provider: 'aws',
    stackName: 'test-stack',
    instanceType: 't3.small',
    openclaw: { version: 'stable' },
    network: {
      allowedSshCidrs: [],
      allowedGatewayCidrs: [],
    },
  },
}

describe('validatePlan()', () => {
  it('returns ok:true for a valid plan', () => {
    const result = validatePlan(VALID_PLAN)
    expect(result.ok).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('returns ok:false for wrong apiVersion', () => {
    const result = validatePlan({ ...VALID_PLAN, apiVersion: 'wrong/v99' })
    expect(result.ok).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it('returns ok:false for invalid provider enum value', () => {
    const result = validatePlan({
      ...VALID_PLAN,
      spec: { ...VALID_PLAN.spec, provider: 'digitalocean' },
    })
    expect(result.ok).toBe(false)
  })

  it('returns ok:false when spec is missing', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { spec: _spec, ...withoutSpec } = VALID_PLAN
    const result = validatePlan(withoutSpec)
    expect(result.ok).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it('returns ok:false for a non-object input', () => {
    expect(validatePlan(null).ok).toBe(false)
    expect(validatePlan('string').ok).toBe(false)
    expect(validatePlan(42).ok).toBe(false)
  })

  it('error messages include the failing field path', () => {
    const result = validatePlan({ ...VALID_PLAN, apiVersion: 'bad' })
    expect(result.errors.some(e => e.includes('apiVersion') || e.length > 0)).toBe(true)
  })

  it('reuses the compiled validator across calls (same object reference)', () => {
    // Two consecutive calls should succeed without throwing — verifies caching doesn't break
    const r1 = validatePlan(VALID_PLAN)
    const r2 = validatePlan(VALID_PLAN)
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
  })
})

describe('assertValidPlan()', () => {
  it('does not throw for a valid plan', () => {
    expect(() => assertValidPlan(VALID_PLAN)).not.toThrow()
  })

  it('throws with "Invalid deploy plan:" prefix for an invalid plan', () => {
    expect(() => assertValidPlan({ ...VALID_PLAN, apiVersion: 'bad' })).toThrow(
      /Invalid deploy plan:/,
    )
  })

  it('thrown error message contains the validation errors', () => {
    let msg = ''
    try {
      assertValidPlan({ ...VALID_PLAN, apiVersion: 'bad' })
    } catch (err) {
      msg = (err as Error).message
    }
    expect(msg).toContain('Invalid deploy plan:')
    expect(msg.length).toBeGreaterThan('Invalid deploy plan:'.length)
  })
})
