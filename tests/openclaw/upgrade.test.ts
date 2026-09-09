// Upgrade safety: snapshot, judge, swap.
//
// `clawops gateway update` was pull → run → report success. `docker run` exiting 0 means
// the container was created, not that the gateway started — and the container it replaced
// is already gone by then.

import { describe, it, expect } from 'vitest'
import {
  judgePreflight, parsePreflight, snapshotCommand, preflightCommand, snapshotPathFrom,
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
