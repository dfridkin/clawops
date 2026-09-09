// Validating the OpenClaw config a plan carries, at plan time.
//
// `spec.openclaw.config` is free-form in the plan schema — deliberately, since it mirrors
// whatever OpenClaw accepts. The consequence was that a plan with an invalid config passed
// plan validation completely and failed at write time, on the host, after provisioning.
//
// That defeats the Maker flow: the plan is what a human reviews before anything reaches
// their cloud account, and a config error the plan cannot express is one review cannot
// catch.

import { describe, it, expect } from 'vitest'
import { validatePlanConfig } from '../../src/plan/validate.js'

const plan = (config: unknown, version = '2026.9.2') => ({
  spec: { openclaw: { version, config } },
})

describe('validatePlanConfig', () => {
  it('passes a plan with no config overlay', async () => {
    const r = await validatePlanConfig({ spec: { openclaw: { version: '2026.9.2' } } })
    expect(r.ok).toBe(true)
  })

  it('accepts a valid overlay', async () => {
    const r = await validatePlanConfig(plan({ gateway: { port: 19000 } }))
    expect(r.ok).toBe(true)
    expect(r.errors).toEqual([])
  })

  it('rejects a config the gateway would reject', async () => {
    const r = await validatePlanConfig(plan({ gateway: { port: 'nineteen thousand' } }))
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toMatch(/gateway\.port/)
  })

  it('rejects a key OpenClaw does not have', async () => {
    const r = await validatePlanConfig(plan({ models: { maxAgents: 4 } }))
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toMatch(/unknown key "maxAgents"/)
  })

  it('does not demand gateway.mode from a fragment', async () => {
    // The overlay is merged ONTO a provisioned config that already has gateway.mode.
    // Demanding it here would make every operator repeat a field they have no reason to
    // set, to satisfy a rule about the merged result rather than the fragment.
    const r = await validatePlanConfig(plan({ channels: {} }))
    expect(r.ok).toBe(true)
    expect(r.errors.join(' ')).not.toMatch(/gateway\.mode/)
  })

  it('warns rather than fails on an unknown key when the plan targets a newer OpenClaw', async () => {
    const r = await validatePlanConfig(plan({ gateway: { someFutureSetting: true } }, '2027.1.1'))
    expect(r.ok).toBe(true)
    expect(r.warnings.join(' ')).toMatch(/someFutureSetting/)
  })
})
