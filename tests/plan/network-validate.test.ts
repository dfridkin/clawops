import { describe, it, expect } from 'vitest'
import { validatePlanNetwork } from '../../src/plan/validate.js'
import { resolveGatewayIngressCidrs, resolveGatewayPort } from '../../src/providers/firewall.js'

const DENY = { ok: false as const, error: 'not used' }

function plan(network: Record<string, unknown>, config?: unknown) {
  return { spec: { network, openclaw: config === undefined ? undefined : { config } } }
}

describe('validatePlanNetwork', () => {
  it('accepts the default shape: loopback, no gateway CIDRs', () => {
    const r = validatePlanNetwork(plan({ allowedSshCidrs: ['10.0.0.1/32'], allowedGatewayCidrs: [] }))
    expect(r.ok).toBe(true)
    expect(r.errors).toEqual([])
  })

  it('refuses gateway CIDRs alongside loopback publishing', () => {
    // The rules would admit traffic to a port nothing routable is listening on: no access
    // granted, and a security group that reads as an exposed gateway to anyone auditing it.
    const r = validatePlanNetwork(
      plan({ allowedSshCidrs: [], allowedGatewayCidrs: ['10.0.0.1/32'], publishGateway: 'loopback' }),
    )
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toMatch(/publishGateway is "loopback"/)
    expect(r.errors.join(' ')).toMatch(/clawops tunnel/)
  })

  it('refuses gateway CIDRs when publishGateway is simply absent', () => {
    // Absent means loopback. A check that only fired on the explicit value would miss the
    // common case.
    const r = validatePlanNetwork(plan({ allowedSshCidrs: [], allowedGatewayCidrs: ['10.0.0.1/32'] }))
    expect(r.ok).toBe(false)
  })

  it('accepts gateway CIDRs when the gateway is published', () => {
    const r = validatePlanNetwork(
      plan({ allowedSshCidrs: [], allowedGatewayCidrs: ['10.0.0.1/32'], publishGateway: 'all' }),
    )
    expect(r.ok).toBe(true)
  })

  it('warns, but does not refuse, a plan that asks for the whole internet', () => {
    // N10 governs defaults. An operator who explicitly writes 0.0.0.0/0 gets what they
    // asked for and a finding from `clawops harden`.
    const r = validatePlanNetwork(
      plan({ allowedSshCidrs: ['0.0.0.0/0'], allowedGatewayCidrs: [], publishGateway: 'loopback' }),
    )
    expect(r.ok).toBe(true)
    expect(r.warnings.join(' ')).toMatch(/allowedSshCidrs admits the whole internet/)
  })

  it('warns on ::/0 as well as 0.0.0.0/0', () => {
    const r = validatePlanNetwork(plan({ allowedSshCidrs: ['::/0'], allowedGatewayCidrs: [] }))
    expect(r.warnings.join(' ')).toMatch(/whole internet/)
  })

  it('refuses a published port that disagrees with the configured one', () => {
    // The container would publish one port while the gateway listened on the other: it
    // starts, satisfies a container-level check, and answers nothing.
    const r = validatePlanNetwork(
      plan(
        { allowedSshCidrs: [], allowedGatewayCidrs: [], gatewayPort: 9443 },
        { gateway: { port: 18789 } },
      ),
    )
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toMatch(/9443.*18789|18789.*9443/)
  })

  it('accepts a config that sets the same port', () => {
    const r = validatePlanNetwork(
      plan(
        { allowedSshCidrs: [], allowedGatewayCidrs: [], gatewayPort: 9443 },
        { gateway: { port: 9443 } },
      ),
    )
    expect(r.ok).toBe(true)
  })

  it('accepts a config that says nothing about the port', () => {
    const r = validatePlanNetwork(
      plan({ allowedSshCidrs: [], allowedGatewayCidrs: [], gatewayPort: 9443 }, { gateway: {} }),
    )
    expect(r.ok).toBe(true)
  })

  it('says nothing about a plan with no network block', () => {
    expect(validatePlanNetwork({ spec: {} }).ok).toBe(true)
  })
})

describe('resolveGatewayIngressCidrs', () => {
  it('returns nothing under loopback, whatever the access mode asks for', () => {
    expect(resolveGatewayIngressCidrs('loopback', 'open', '', '', DENY)).toEqual([])
    expect(resolveGatewayIngressCidrs('loopback', 'restricted', '10.0.0.1/32', '', DENY)).toEqual([])
    expect(resolveGatewayIngressCidrs('loopback', 'restricted', '', '10.0.0.1/32', DENY)).toEqual([])
  })

  it('resolves normally when the gateway is published', () => {
    expect(resolveGatewayIngressCidrs('all', 'restricted', '10.0.0.1/32', '', DENY))
      .toEqual(['10.0.0.1/32'])
    expect(resolveGatewayIngressCidrs('all', 'open', '', '', DENY)).toEqual(['0.0.0.0/0'])
  })

  it('treats an unrecognised publish value as loopback', () => {
    // The safe direction. Anything that is not an explicit "all" keeps the port closed.
    expect(resolveGatewayIngressCidrs('', 'open', '', '', DENY)).toEqual([])
    expect(resolveGatewayIngressCidrs('ALL', 'open', '', '', DENY)).toEqual([])
  })
})

describe('resolveGatewayPort', () => {
  it('reads a configured port', () => {
    expect(resolveGatewayPort('9443', 18789)).toBe(9443)
  })

  it('falls back for a stack created before the setting existed', () => {
    expect(resolveGatewayPort(undefined, 18789)).toBe(18789)
  })

  it.each(['', 'not-a-port', '0', '65536', '-1', '80.5'])(
    'falls back rather than accepting %s',
    (raw) => {
      expect(resolveGatewayPort(raw, 18789)).toBe(18789)
    },
  )
})
