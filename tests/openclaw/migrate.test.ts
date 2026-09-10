// Migrating a 1.x deployment to the 2.0 runtime contract.
//
// The sequence is not the obvious one. SP-07 found two wrong assumptions and a re-run on
// 2026-09-09 added a third; each is asserted here, because each is a step someone would
// reasonably remove.

import { describe, it, expect } from 'vitest'
import { migrate, describeMigration, type MigrateSteps } from '../../src/openclaw/migrate.js'

function steps(over: Partial<MigrateSteps> = {}, log: string[] = []) {
  const base: MigrateSteps = {
    inspectSource: async () => { log.push('inspect'); return 'ghcr.io/openclaw/openclaw:2026.7.1-2' },
    backup: async () => { log.push('backup'); return { ok: true, detail: '/tmp/b.tar.gz (verified)' } },
    extract: async () => { log.push('extract'); return { ok: true, entries: ['identity', 'state', 'workspace'] } },
    chown: async () => { log.push('chown') },
    removeSource: async () => { log.push('remove') },
    writeConfig: async () => { log.push('config') },
    start: async () => { log.push('start') },
    gate: async () => { log.push('gate'); return { ok: true } },
    deviceId: async () => 'abc123',
  }
  return { steps: { ...base, ...over }, log }
}


/**
 * Assert `first` happened, `second` happened, and in that order.
 *
 * `indexOf(a) < indexOf(b)` alone is satisfied when `a` never ran at all — indexOf returns
 * -1, which is less than anything. Mutation testing found exactly that: deleting the chown
 * step left the ordering assertion green.
 */
function ranInOrder(log: string[], first: string, second: string) {
  expect(log, `${first} must run`).toContain(first)
  expect(log, `${second} must run`).toContain(second)
  expect(log.indexOf(first), `${first} must precede ${second}`).toBeLessThan(log.indexOf(second))
}

describe('migrate — the sequence', () => {
  it('extracts from the RUNNING container, before stopping it', async () => {
    // Stopping first destroys what the migration came to save: all 1.x state lives inside
    // the container, and clawops 1.x mounted none of it.
    const { steps: s, log } = steps()
    const out = await migrate(s)
    expect(out.kind).toBe('migrated')
    ranInOrder(log, 'extract', 'remove')
  })

  it('backs up before extracting, and refuses if the backup fails', async () => {
    const { steps: s, log } = steps({
      backup: async () => ({ ok: false, detail: 'archive verification failed' }),
    })
    const out = await migrate(s)
    expect(out.kind).toBe('refused')
    if (out.kind === 'refused') expect(out.reason).toMatch(/verified backup/)
    // Nothing was touched.
    expect(log).not.toContain('extract')
    expect(log).not.toContain('remove')
  })

  it('owns the state numerically before starting 2.0 (G25)', async () => {
    const { steps: s, log } = steps()
    await migrate(s)
    ranInOrder(log, 'chown', 'start')
  })

  it('writes a config, because 1.x has none that applied', async () => {
    // 1.x never wrote a config that took effect, and 2.0 refuses to start without
    // gateway.mode. The config is synthesised, not carried forward.
    const { steps: s, log } = steps()
    await migrate(s)
    ranInOrder(log, 'config', 'start')
  })

  it('restarts once when the first start is still migrating the schema', async () => {
    // Measured: 2.0 reports "state database schema migration required (audit-events-v2)"
    // on the first start and is healthy only after a second.
    let calls = 0
    const { steps: s, log } = steps({
      gate: async () => { calls++; return calls === 1 ? { ok: false, reason: 'still starting' } : { ok: true } },
    })
    const out = await migrate(s)
    expect(out.kind).toBe('migrated')
    if (out.kind === 'migrated') expect(out.restarts).toBe(1)
    expect(log.filter((l) => l === 'start')).toHaveLength(2)
  })

  it('does not restart forever', async () => {
    const { steps: s, log } = steps({ gate: async () => ({ ok: false, reason: 'dead' }) })
    const out = await migrate(s)
    expect(out.kind).toBe('failed')
    expect(log.filter((l) => l === 'start')).toHaveLength(2)
  })
})

describe('migrate — device identity', () => {
  it('reports preserved identity', async () => {
    const { steps: s } = steps({ deviceId: async () => 'same-id' })
    const out = await migrate(s)
    if (out.kind === 'migrated') expect(out.identity).toBe('preserved')
    expect(describeMigration(out)).toMatch(/do not need re-pairing/)
  })

  it('reports a CHANGED identity, because pairings then break', async () => {
    let n = 0
    const { steps: s } = steps({ deviceId: async () => (n++ === 0 ? 'before' : 'after') })
    const out = await migrate(s)
    if (out.kind === 'migrated') expect(out.identity).toBe('changed')
    expect(describeMigration(out)).toMatch(/must be re-paired/)
  })

  it('says so when it could not tell, rather than implying continuity', async () => {
    const { steps: s } = steps({ deviceId: async () => undefined })
    const out = await migrate(s)
    if (out.kind === 'migrated') expect(out.identity).toBe('unknown')
    expect(describeMigration(out)).toMatch(/could not be compared/)
  })
})

describe('migrate — nothing to rescue', () => {
  it('says plainly that the state is already gone', async () => {
    // G2: clawops mounted no state, so anyone who ran gateway restart/update/config set
    // before 2.0 lost it. Pretending there is something to migrate would be worse than
    // saying so.
    const { steps: s, log } = steps({ inspectSource: async () => undefined })
    const out = await migrate(s)
    expect(out.kind).toBe('nothing-to-migrate')
    expect(describeMigration(out)).toMatch(/already lost/)
    expect(describeMigration(out)).toMatch(/clawops up/)
    // The override replaces the logging inspectSource, so assert what matters: nothing
    // else ran. No backup, no extraction, no container removed.
    expect(log).toEqual([])
  })
})

describe('migrate — reporting', () => {
  it('never claims the old config was applied', async () => {
    // It was not applied on 1.x either — the mounted file was read by nothing. Telling an
    // operator their settings carried over would be false.
    const { steps: s } = steps()
    const text = describeMigration(await migrate(s))
    expect(text).toMatch(/NOT applied/)
    expect(text).toMatch(/never took effect/)
  })

  it('points a failed migration at the backup it took', async () => {
    const { steps: s } = steps({ gate: async () => ({ ok: false, reason: 'exit 78' }) })
    const text = describeMigration(await migrate(s))
    expect(text).toMatch(/verified backup was taken first/)
    expect(text).toMatch(/clawops backup restore/)
  })
})
