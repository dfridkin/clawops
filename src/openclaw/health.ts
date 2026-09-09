// Health probing for the OpenClaw gateway.
//
// clawops had three probes across three files, on two different paths — `remote-config.ts`
// used `/healthz`, `bootstrap.ts` and `monitor.ts` used `/health` — and none of them could
// fail for the right reason.
//
// The gateway serves its Control UI as a single-page app with a catch-all route, so ANY
// unmatched path returns 200 with `text/html`. Measured on 2026.9.2:
//
//   /healthz                        200  application/json   {"ok":true,"status":"live"}
//   /health-typo                    200  text/html          <!doctype html>…
//   /obviously-not-a-real-endpoint  200  text/html          <!doctype html>…
//
// So `curl -fsS …/health-typo` succeeds. The old probe validated that *something* was
// listening on the port, not that the gateway was healthy — and it would have gone on
// passing if the endpoint were renamed or removed upstream.
//
// Every probe here asserts the JSON payload.

/** Endpoints verified present on 2026.9.2, with the payload each returns. */
export const HEALTH_PATHS = {
  /** Process is up and serving. `{"ok":true,"status":"live"}` */
  live: '/health',
  /** Startup completed — the gate for "is this deploy finished". `{"ok":true,"status":"started"}` */
  started: '/startupz',
  /** Accepting work. `{"ready":true}` */
  ready: '/readyz',
} as const

export type HealthKind = keyof typeof HEALTH_PATHS

/**
 * Probe command for a remote host.
 *
 * Prints the body so the caller can judge it. `-o -` rather than `-o /dev/null`: a probe
 * that discards the response can only check the status code, which is exactly the failure
 * described above.
 */
export function probeCommand(kind: HealthKind, port: number, pathPrefix = ''): string {
  return (
    `${pathPrefix}curl -fsS -m 5 http://127.0.0.1:${port}${HEALTH_PATHS[kind]} 2>/dev/null || true`
  )
}

export interface ProbeResult {
  ok: boolean
  /** Why it failed, in terms an operator can act on. */
  reason?: string
}

/**
 * Interpret a probe body.
 *
 * Rejects HTML explicitly rather than merely failing to find the expected key: a caller
 * seeing "unexpected response" would reasonably suspect the gateway, when the real cause is
 * a path that does not exist and fell through to the Control UI.
 */
export function interpretProbe(kind: HealthKind, body: string): ProbeResult {
  const text = body.trim()
  if (text === '') return { ok: false, reason: 'no response from the gateway' }

  if (text.startsWith('<')) {
    return {
      ok: false,
      reason:
        `${HEALTH_PATHS[kind]} returned HTML, not JSON — the gateway serves its Control UI ` +
        `on a catch-all route, so an unknown path answers 200 with the SPA. The endpoint is ` +
        `missing or renamed on this OpenClaw version.`,
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, reason: `${HEALTH_PATHS[kind]} returned unparseable JSON: ${text.slice(0, 80)}` }
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { ok: false, reason: `${HEALTH_PATHS[kind]} returned ${text.slice(0, 40)}` }
  }

  const obj = parsed as Record<string, unknown>
  if (kind === 'ready') {
    return obj['ready'] === true
      ? { ok: true }
      : { ok: false, reason: `gateway is not ready: ${text.slice(0, 80)}` }
  }
  if (obj['ok'] !== true) {
    return { ok: false, reason: `gateway reported not ok: ${text.slice(0, 80)}` }
  }
  if (kind === 'started' && obj['status'] !== 'started') {
    return { ok: false, reason: `gateway is still starting (status: ${String(obj['status'])})` }
  }
  return { ok: true }
}
