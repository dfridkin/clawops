// An interlock between the version guard and the runtime that has to honour it.
//
// `support.min`/`max` are enforced live by `up`, `plan`, `apply` and `doctor`. The
// runtime code that actually deploys OpenClaw is a separate thing, and the two can
// disagree silently: flipping the range to the 2.0 line before WO-38/39/40 land would
// make clawops refuse 2026.7.1-2 (the only version it can deploy correctly) while
// accepting 2026.9.1+ (which it would deploy with the 1.x contract, and crash-loop).
// That inverts the guard precisely when it matters.
//
// So the flip is gated. `line: "2.x"` in spec/openclaw-versions.yaml is a claim that
// the runtime implements the 2.0 contract, and these assertions are what that claim
// costs. Each is measured in docs/spikes/SP-10-openclaw-2.0-startup-contract.md.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { load } from 'js-yaml'
import { gatewayRunCommand, compareVersions } from '../helpers/line-interlock-imports.js'

const root = resolve(import.meta.dirname, '../..')
const read = (p: string) => readFileSync(resolve(root, p), 'utf8')

interface VersionSpec {
  line: string
  support: { min: string; max?: string; recommended?: string }
  runtime: { targetMin: string; startup: { gatewayMode: string; allowUnconfigured: boolean } }
}

const spec = load(read('spec/openclaw-versions.yaml')) as VersionSpec

describe('release line interlock', () => {
  it('declares a line', () => {
    expect(['1.x', '2.x']).toContain(spec.line)
  })

  it('recommends a version inside its own supported range', () => {
    const { min, max, recommended } = spec.support
    if (!recommended) return
    expect(compareVersions(recommended, min)).toBeGreaterThanOrEqual(0)
    if (max) expect(compareVersions(recommended, max)).toBeLessThanOrEqual(0)
  })

  it('on the 1.x line, still refuses the 2.0 runtime', () => {
    if (spec.line !== '1.x') return
    expect(spec.support.max, '1.x must keep an upper bound or it accepts 2.0').toBeTruthy()
    expect(compareVersions(spec.support.max!, spec.runtime.targetMin)).toBeLessThan(0)
  })

  it('on the 2.x line, the runtime must actually implement the 2.0 contract', () => {
    if (spec.line !== '2.x') return

    // Guard and runtime must agree on the floor.
    expect(compareVersions(spec.support.min, spec.runtime.targetMin)).toBeGreaterThanOrEqual(0)

    // SP-10 §1: without gateway.mode the gateway exits 78. Passing
    // --allow-unconfigured instead bypasses upstream's clobbered-config check.
    const cmd = gatewayRunCommand({ image: 'img:tag', configPath: '/tmp/c.json' })
    expect(cmd, 'the 2.x line must not depend on --allow-unconfigured').not.toContain(
      '--allow-unconfigured',
    )
    expect(spec.runtime.startup.allowUnconfigured).toBe(false)

    // The config clawops writes has to carry the mode the gateway demands.
    const writesMode = ['src/providers/startup.ts', 'src/providers/local/bootstrap.sh.tmpl']
      .map(read)
      .every((src) => /"mode"\s*:\s*"local"/.test(src))
    expect(writesMode, 'provisioning must write gateway.mode=local').toBe(true)
  })
})
