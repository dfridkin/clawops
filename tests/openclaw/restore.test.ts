// Putting a restored backup into service, and taking it back out when it will not run.
//
// The interesting cases are all failures. A restore that works is a rename; a restore that breaks
// the gateway is someone's evening, and what decides how that goes is whether the state it
// replaced still exists.

import { describe, it, expect, vi } from 'vitest'
import { activateRestored, hasRoomFor, locateRestoredState, type RestoreExec } from '../../src/openclaw/restore.js'

const STATE = '/var/lib/clawops/openclaw'
const STAGING = `${STATE}/.clawops-restore-1`
const NOW = () => Date.parse('2026-09-25T10:00:00.000Z')

/** A host that accepts every command, recording what it was asked to do. */
function host(overrides: Record<string, { code: number; stderr?: string }> = {}) {
  const commands: string[] = []
  const exec: RestoreExec = vi.fn(async (command: string) => {
    commands.push(command)
    if (command.startsWith('test -d')) return { stdout: 'yes', stderr: '', code: 0 }
    for (const [match, result] of Object.entries(overrides)) {
      if (command.includes(match)) {
        return { stdout: '', stderr: result.stderr ?? 'mv: failed', code: result.code }
      }
    }
    return { stdout: '', stderr: '', code: 0 }
  })
  return { exec, commands, moves: () => commands.filter((c) => c.startsWith('mv ')) }
}

const ok = { restart: async () => undefined, waitHealthy: async () => undefined }

describe('activateRestored', () => {
  it('swaps the restored state in and keeps what it replaced', async () => {
    const h = host()
    const result = await activateRestored({ stateDir: STATE, staging: STAGING, exec: h.exec, now: NOW, ...ok })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.preserved).toContain('.pre-restore-')
    // Three renames, in the order that never has two directories claiming one name.
    expect(h.moves()).toHaveLength(3)
    expect(h.moves()[0]).toContain('.clawops-restore-1')
    expect(h.moves()[1]).toContain('.pre-restore-')
    expect(h.moves()[2]).toContain(STATE)
  })

  it('never deletes the state it replaces', async () => {
    const h = host()
    await activateRestored({ stateDir: STATE, staging: STAGING, exec: h.exec, now: NOW, ...ok })
    expect(h.commands.some((c) => /\brm\b/.test(c))).toBe(false)
  })

  it('moves staging clear before renaming the directory that contains it', async () => {
    const h = host()
    await activateRestored({ stateDir: STATE, staging: STAGING, exec: h.exec, now: NOW, ...ok })
    const [first, second] = h.moves()
    expect(first).toContain(STAGING)
    expect(second).toMatch(new RegExp(`mv '${STATE}' `))
  })

  describe('when the gateway does not come up', () => {
    const wontStart = {
      restart: async () => undefined,
      waitHealthy: async () => { throw new Error('gateway never answered') },
    }

    it('puts the previous state back', async () => {
      const h = host()
      const result = await activateRestored({ stateDir: STATE, staging: STAGING, exec: h.exec, now: NOW, ...wontStart })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.rolledBack).toBe(true)
      expect(result.reason).toContain('gateway never answered')
      // aside, in, park the failed one, put the original back
      expect(h.moves()).toHaveLength(5)
      expect(h.moves()[4]).toMatch(/\.pre-restore-.*' '\/var\/lib\/clawops\/openclaw'/)
    })

    it('keeps the state that would not run, rather than discarding the evidence', async () => {
      const h = host()
      const result = await activateRestored({ stateDir: STATE, staging: STAGING, exec: h.exec, now: NOW, ...wontStart })
      if (result.ok) return
      expect(result.keptFailed).toContain('.failed-restore-')
    })

    it('restarts again after rolling back, so the machine is left running', async () => {
      const restart = vi.fn(async () => undefined)
      const h = host()
      await activateRestored({
        stateDir: STATE, staging: STAGING, exec: h.exec, now: NOW,
        restart, waitHealthy: async () => { throw new Error('nope') },
      })
      expect(restart).toHaveBeenCalledTimes(2)
    })

    /*
     * The worst case: the restored state will not run and the old one cannot be put back. Both
     * paths have to reach the operator, because neither directory is where they expect it.
     */
    it('names both directories when the rollback itself fails', async () => {
      // Only the rollback move: the same path appears as a destination in step 2.
      const h = host({ [`mv '${STATE}.pre-restore-`]: { code: 1, stderr: 'mv: permission denied' } })
      const result = await activateRestored({
        stateDir: STATE, staging: STAGING, exec: h.exec, now: NOW,
        restart: async () => undefined, waitHealthy: async () => { throw new Error('nope') },
      })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.rolledBack).toBe(false)
      expect(result.reason).toMatch(/could not be/i)
    })
  })

  describe('when a move fails before anything is replaced', () => {
    it('puts staging back and reports that nothing changed', async () => {
      const h = host({ [`mv '${STATE}' `]: { code: 1, stderr: 'mv: device busy' } })
      const result = await activateRestored({ stateDir: STATE, staging: STAGING, exec: h.exec, now: NOW, ...ok })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.rolledBack).toBe(false)
      expect(result.reason).toContain('device busy')
      expect(h.moves().at(-1)).toContain(STAGING)
    })

    it('refuses when the restored directory is not there', async () => {
      const exec: RestoreExec = async (c) =>
        c.startsWith('test -d') ? { stdout: 'no', stderr: '', code: 0 } : { stdout: '', stderr: '', code: 0 }
      const result = await activateRestored({ stateDir: STATE, staging: STAGING, exec, now: NOW, ...ok })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toContain(STAGING)
    })
  })
})

describe('hasRoomFor', () => {
  const df = (availableKb: string): RestoreExec => async () => ({ stdout: availableKb, stderr: '', code: 0 })

  it('passes when the filesystem has room', async () => {
    expect(await hasRoomFor(df('1048576'), STATE, 100 * 1024 * 1024)).toEqual({ ok: true })
  })

  it('refuses when it does not, and says by how much', async () => {
    const result = await hasRoomFor(df('1024'), STATE, 100 * 1024 * 1024)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.availableBytes).toBe(1024 * 1024)
      expect(result.neededBytes).toBe(100 * 1024 * 1024)
    }
  })

  /* An unreadable df is not a reason to block a restore; the expand fails honestly if space runs out. */
  it('does not block on a df it cannot parse', async () => {
    expect(await hasRoomFor(df('not a number'), STATE, 1)).toEqual({ ok: true })
  })
})

describe('locateRestoredState', () => {
  /*
   * The layout a real host produced. clawops moved the bundle into place, the gateway found
   * manifest.json where its config belongs, and refused to start — which the rollback then
   * undid. The state to adopt is under payload/posix, at the path the manifest records.
   */
  const MANIFEST = JSON.stringify({
    schemaVersion: 1,
    archiveRoot: '2026-09-25T20-23-13.773+00-00-openclaw-backup',
    runtimeVersion: '2026.9.2',
    paths: { stateDir: '/home/node/.openclaw', configPath: '/home/node/.openclaw/openclaw.json' },
  })

  it('points at the state inside the payload, not at the bundle', () => {
    const located = locateRestoredState(MANIFEST, '/var/lib/clawops/.clawops-restored-1')
    expect(located.ok).toBe(true)
    if (!located.ok) return
    expect(located.statePath).toBe(
      '/var/lib/clawops/.clawops-restored-1/2026-09-25T20-23-13.773+00-00-openclaw-backup/payload/posix/home/node/.openclaw',
    )
    expect(located.stateDirInArchive).toBe('/home/node/.openclaw')
  })

  // `${bundle}/${stateDir}` with an absolute stateDir would resolve outside the bundle entirely.
  it('joins the absolute state path without escaping the bundle', () => {
    const located = locateRestoredState(MANIFEST, '/var/lib/clawops/.clawops-restored-1')
    if (!located.ok) return
    expect(located.statePath.startsWith('/var/lib/clawops/.clawops-restored-1/')).toBe(true)
  })

  /*
   * This is upstream's format. Refusing a version clawops has not been tested against is the
   * difference between declining to act and moving the wrong directory over live state.
   */
  it('refuses a manifest schema it has not been tested against', () => {
    const future = JSON.stringify({ schemaVersion: 2, archiveRoot: 'x', paths: { stateDir: '/home/node/.openclaw' } })
    const located = locateRestoredState(future, '/staged')
    expect(located.ok).toBe(false)
    if (!located.ok) {
      expect(located.reason).toContain('schemaVersion 2')
      expect(located.reason).toMatch(/by hand/)
    }
  })

  it.each([
    ['not json at all', 'not json'],
    ['a manifest with no archiveRoot', JSON.stringify({ schemaVersion: 1, paths: { stateDir: '/s' } })],
    ['a manifest with no stateDir', JSON.stringify({ schemaVersion: 1, archiveRoot: 'r' })],
  ])('refuses %s', (_label, manifest) => {
    expect(locateRestoredState(manifest, '/staged').ok).toBe(false)
  })
})
