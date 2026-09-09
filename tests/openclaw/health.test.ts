// Health probing.
//
// clawops had three probes across three files on two different paths, and none could fail
// for the right reason. The gateway serves its Control UI on a catch-all route, so any
// unmatched path answers 200 with text/html. Measured on 2026.9.2:
//
//   /healthz                        200  application/json   {"ok":true,"status":"live"}
//   /health-typo                    200  text/html          <!doctype html>…
//   /obviously-not-a-real-endpoint  200  text/html          <!doctype html>…
//
// `curl -fsS …/health-typo` therefore SUCCEEDS. The old probes proved something was
// listening on the port, not that the gateway was healthy — and would have kept passing if
// the endpoint were renamed upstream.

import { describe, it, expect } from 'vitest'
import { HEALTH_PATHS, probeCommand, interpretProbe } from '../../src/openclaw/health.js'

describe('probeCommand', () => {
  it('asks for the body, not just a status code', () => {
    const cmd = probeCommand('started', 18789)
    // -o /dev/null would discard the only evidence that distinguishes a real endpoint from
    // the SPA fallback.
    expect(cmd).not.toContain('-o /dev/null')
    expect(cmd).toContain(HEALTH_PATHS.started)
    expect(cmd).toContain('127.0.0.1:18789')
    expect(cmd).toContain('-m 5')
  })

  it('honours a PATH prefix for hosts where curl is not on a login PATH', () => {
    expect(probeCommand('live', 18789, 'export PATH=/x:$PATH && ')).toMatch(/^export PATH/)
  })
})

describe('interpretProbe', () => {
  it('accepts the real payloads', () => {
    expect(interpretProbe('live', '{"ok":true,"status":"live"}').ok).toBe(true)
    expect(interpretProbe('started', '{"ok":true,"status":"started"}').ok).toBe(true)
    expect(interpretProbe('ready', '{"ready":true}').ok).toBe(true)
  })

  it('rejects the Control UI, and says why', () => {
    // The failure this module exists for. Without naming the cause, an operator would
    // reasonably suspect the gateway when the real problem is a path that does not exist.
    const r = interpretProbe('started', '<!doctype html><html data-openclaw-control-ui…')
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/HTML, not JSON/)
    expect(r.reason).toMatch(/catch-all|Control UI/)
  })

  it('does not treat "live" as "started"', () => {
    // After a restart the process listens long before startup finishes. A liveness probe
    // returns ok while the gateway is still converging — and the caller is about to tell
    // the operator the deploy succeeded.
    const r = interpretProbe('started', '{"ok":true,"status":"live"}')
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/still starting/)
  })

  it('rejects an unhealthy report', () => {
    expect(interpretProbe('live', '{"ok":false,"status":"degraded"}').ok).toBe(false)
    expect(interpretProbe('ready', '{"ready":false}').ok).toBe(false)
  })

  it('rejects nothing, garbage and non-objects', () => {
    for (const body of ['', '   ', 'not json', '42', '"live"']) {
      expect(interpretProbe('live', body).ok, JSON.stringify(body)).toBe(false)
    }
  })
})

describe('no probe checks only a status code', () => {
  it('every health probe in src/ goes through this module', async () => {
    // Three files used to hand-roll their own curl, on two different paths. A status-code
    // check is indistinguishable from a typo, so the guard is that nobody writes one.
    const { readFileSync, readdirSync, statSync } = await import('node:fs')
    const { resolve, join } = await import('node:path')
    const root = resolve(import.meta.dirname, '../../src')

    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const full = join(dir, n)
        return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : []
      })

    const offenders = walk(root)
      .filter((f) => !f.endsWith('openclaw/health.ts'))
      .filter((f) => /curl[^\n]*\/(health|healthz|startupz|readyz)/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(root.length + 1))

    expect(offenders, `hand-rolled health probes:\n${offenders.join('\n')}`).toEqual([])
  })
})
