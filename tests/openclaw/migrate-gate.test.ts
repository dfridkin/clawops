// How long a migration waits for the 2.x gateway before trying its second start.
//
// The first 2.x start on 1.x state runs a schema migration. On a slow host it has not answered
// at all after 30 seconds, and the old gate gave up then — so the second start landed in the
// middle of the migration, and a CI run showed the gateway never coming back. A gateway that
// has not answered gets two minutes; one that answers "not started" gets the old 30 seconds.

import { describe, it, expect } from 'vitest'
import { migrationSteps } from '../../src/openclaw/migrate-flow.js'

const STARTED = '{"ok":true,"status":"started"}'
const PENDING = '{"ok":false,"status":"migration-required"}'

/** A host whose /startupz answers `bodies[i]` on the i-th probe, and the last one forever after. */
function gateOn(bodies: string[]) {
  let probes = 0
  const run = async (cmd: string) => {
    if (cmd.includes('startupz')) {
      const body = bodies[Math.min(probes, bodies.length - 1)]!
      probes++
      return { stdout: body, stderr: '', code: 0 }
    }
    return { stdout: '', stderr: '', code: 0 }
  }
  const steps = migrationSteps(run, { targetImage: 'img:2026.9.2', sleep: async () => {} })
  return { gate: () => steps.gate(), probes: () => probes }
}

describe('the migration start gate', () => {
  it('keeps waiting through a minute of silence instead of restarting a gateway mid-migration', async () => {
    const g = gateOn([...Array<string>(30).fill(''), STARTED]) // 60s of no answer, then started
    const out = await g.gate()
    expect(out.ok).toBe(true)
    expect(g.probes()).toBe(31)
  })

  it('gives silence up to two minutes, then reports what it saw', async () => {
    const g = gateOn([''])
    const out = await g.gate()
    expect(out.ok).toBe(false)
    expect(g.probes()).toBe(60)
    expect(out.reason).toMatch(/no response/)
  })

  it('hands a gateway reporting a pending migration to the second start after 30 seconds', async () => {
    const g = gateOn([PENDING])
    const out = await g.gate()
    expect(out.ok).toBe(false)
    expect(g.probes()).toBe(15)
  })
})
