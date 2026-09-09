// Upgrade safety: snapshot, judge, swap.
//
// `clawops gateway update` was pull → run → report success. `docker run` exiting 0 means
// the container was created, not that the gateway started — and the container it replaced
// is already gone by then.

import { describe, it, expect } from 'vitest'
import {
  judgePreflight, parsePreflight, snapshotCommand, preflightCommand, snapshotPathFrom,
  resolveUpgrade,
} from '../../src/openclaw/upgrade.js'

describe('judgePreflight', () => {
  it('allows an exact schema match', () => {
    expect(judgePreflight({ targetVersion: 15, foundVersion: 15, status: 'exact' }).ok).toBe(true)
  })

  it('allows a forward migration, and says so', () => {
    const r = judgePreflight({ targetVersion: 15, foundVersion: 12 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.note).toMatch(/migrate from schema 12 to 15/)
  })

  it('refuses a downgrade across a schema boundary', () => {
    // NOT demonstrated against real releases: every 2.x image checked (2026.8.1, 2026.9.1,
    // 2026.9.2) reports userVersion 15, so no released pair exercises this. The rule comes
    // from the documented fields and is tested synthetically — the guard exists before it
    // is needed, which is the point, but it has not been proven by observation.
    const r = judgePreflight({ targetVersion: 15, foundVersion: 16 })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toMatch(/downgrade across a schema boundary/)
      expect(r.reason).toMatch(/schema 16.*understands 15/)
      expect(r.reason).toMatch(/Restore a backup/)
    }
  })

  it('refuses when the schema could not be determined', () => {
    // The real message from a live database: the version sits in the WAL until
    // checkpointed, which is why the snapshot exists at all.
    const r = judgePreflight({
      status: 'indeterminate',
      reason: 'SQLite preflight requires a consolidated snapshot with no sidecars; found -wal, -shm.',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/consolidated snapshot/)
  })

  it('refuses a report with no version rather than assuming safety', () => {
    const r = judgePreflight({ status: 'weird' })
    expect(r.ok).toBe(false)
  })
})

describe('parsing', () => {
  it('reads a real preflight report', () => {
    const real = JSON.stringify({
      schema: 'openclaw.state-schema-preflight.v1',
      targetVersion: 15, foundVersion: 15, ownership: null, issues: [], status: 'exact',
    })
    expect(judgePreflight(parsePreflight(real)!).ok).toBe(true)
  })

  it('reads a real snapshot result', () => {
    const real = JSON.stringify({
      ok: true,
      snapshotPath: '/home/node/.openclaw/snaps/2026-09-09T03-46-52-090Z-7ab5b66c',
      manifest: { database: { role: 'global', userVersion: 15 } },
    })
    expect(snapshotPathFrom(real)).toContain('2026-09-09T03-46-52-090Z')
  })

  it('returns nothing for a failed snapshot, rather than a path that does not exist', () => {
    const failed = JSON.stringify({ ok: false, error: { message: 'staging ancestor must not…' } })
    expect(snapshotPathFrom(failed)).toBeUndefined()
    expect(snapshotPathFrom('not json')).toBeUndefined()
    expect(parsePreflight('not json')).toBeUndefined()
  })
})

describe('commands', () => {
  it('snapshots the global database into a repository', () => {
    const cmd = snapshotCommand('img:tag', '/var/lib/clawops/openclaw', '/var/lib/clawops/openclaw/snapshots')
    expect(cmd).toContain('backup sqlite create')
    expect(cmd).toContain('--global')
    expect(cmd).toContain('--json')
  })

  it('preflights with the TARGET image, not the running one', () => {
    // The question is whether the release about to take over understands this database.
    // Asking the current release answers a different question.
    const cmd = preflightCommand('ghcr.io/openclaw/openclaw:2026.9.2', '/state', '/snap/database.sqlite')
    expect(cmd).toContain('ghcr.io/openclaw/openclaw:2026.9.2')
    expect(cmd).toContain('database preflight /snap/database.sqlite')
    expect(cmd).toContain('--json')
  })
})

describe('repairCommand', () => {
  it('never combines --fix with --json', async () => {
    // The CLI refuses that pairing outright: "doctor --json runs read-only lint checks and
    // cannot be combined with --repair, --fix, or --force." It shipped that way in the
    // first cut of WO-45, so the repair step could only ever fail — and the unit fake
    // returns success for any command, so nothing noticed until it ran against the image.
    const { repairCommand } = await import('../../src/openclaw/upgrade.js')
    const cmd = repairCommand('img:tag', '/state')
    expect(cmd).toContain('doctor')
    expect(cmd).toContain('--fix')
    expect(cmd, '--json is rejected when combined with --fix').not.toContain('--json')
    // No TTY during provisioning.
    expect(cmd).toContain('--non-interactive')
  })
})

describe('resolveUpgrade — what happens after the container is created', () => {
  const ctx = { version: '2026.9.2', previousVersion: '2026.9.0', snapshotPath: '/snap/s1' }

  function steps(gateResults: boolean[]) {
    const calls: string[] = []
    let i = 0
    return {
      calls,
      steps: {
        gate: async () => {
          const ok = gateResults[Math.min(i++, gateResults.length - 1)] ?? false
          calls.push(`gate:${ok ? 'ok' : 'fail'}`)
          return ok ? { ok: true } : { ok: false, reason: 'still starting' }
        },
        repair: async () => { calls.push('repair') },
        run: async (v: string) => { calls.push(`run:${v}`) },
      },
    }
  }

  it('reports started when the gateway comes up', async () => {
    const { steps: s, calls } = steps([true])
    expect(await resolveUpgrade(s, ctx)).toEqual({ kind: 'started' })
    // No repair on the happy path — repairing a healthy deployment is thrashing.
    expect(calls).toEqual(['gate:ok'])
  })

  it('repairs ONCE, then re-runs and re-gates', async () => {
    const { steps: s, calls } = steps([false, true])
    expect(await resolveUpgrade(s, ctx)).toEqual({ kind: 'repaired' })
    expect(calls).toEqual(['gate:fail', 'repair', 'run:2026.9.2', 'gate:ok'])
    // One shot, not a loop: SP-07 found a real 1.x→2.0 migration needed no repair at all,
    // so retrying would thrash a deployment with a different problem.
    expect(calls.filter((c) => c === 'repair')).toHaveLength(1)
  })

  it('rolls back to the previous image when repair does not help', async () => {
    const { steps: s, calls } = steps([false, false, true])
    const out = await resolveUpgrade(s, ctx)
    expect(out).toEqual({ kind: 'rolled-back', to: '2026.9.0', reason: 'still starting' })
    expect(calls).toEqual([
      'gate:fail', 'repair', 'run:2026.9.2', 'gate:fail', 'run:2026.9.0', 'gate:ok',
    ])
  })

  it('reports failure, with the snapshot, when the rollback will not come up either', async () => {
    const { steps: s } = steps([false])
    const out = await resolveUpgrade(s, ctx)
    expect(out).toEqual({ kind: 'failed', reason: 'still starting', snapshotPath: '/snap/s1' })
  })

  it('does not attempt a rollback with no previous version to go back to', async () => {
    const { steps: s, calls } = steps([false])
    const out = await resolveUpgrade(s, { ...ctx, previousVersion: undefined })
    expect(out.kind).toBe('failed')
    expect(calls.filter((c) => c.startsWith('run:'))).toEqual(['run:2026.9.2'])
  })
})

describe('describeOutcome', () => {
  it('tells the operator what state they are in', async () => {
    const { describeOutcome } = await import('../../src/openclaw/upgrade.js')
    expect(describeOutcome({ kind: 'started' }, '2026.9.2')).toMatch(/updated to 2026\.9\.2/)
    expect(describeOutcome({ kind: 'repaired' }, '2026.9.2')).toMatch(/one-shot repair/)

    const back = describeOutcome({ kind: 'rolled-back', to: '2026.9.0', reason: 'x' }, '2026.9.2')
    expect(back).toMatch(/Rolled back to 2026\.9\.0/)
    expect(back).toMatch(/previous image is running again/)

    // The failure case must name the snapshot: it is the only way back.
    const dead = describeOutcome({ kind: 'failed', reason: 'x', snapshotPath: '/snap/s1' }, '2026.9.2')
    expect(dead).toMatch(/\/snap\/s1/)
    expect(dead).toMatch(/backup sqlite restore/)
  })
})
