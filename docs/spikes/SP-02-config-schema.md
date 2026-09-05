# SP-02 — What does the OpenClaw 2.0 config schema reject?

**Question.** What does `openclaw config schema` from 2026.8.1 actually reject in the config
clawops emits today, and in a realistic overlay? What happens on a read-only config mount?

**Changes:** WO-36 (capture the schema as a build input), WO-41 (validate before writing), and the
shape of the seed config in `startup.ts` / `bootstrap.sh.tmpl`.

**Confirms or refutes:** G4 (seed config not validated), G3 (read-only mount).

**Environment:** container only — no VM required. Schema output is architecture-independent.

## Method

1. Pull `ghcr.io/openclaw/openclaw:2026.8.1`.
2. `openclaw config schema` → commit as `spec/openclaw-2.0.config.schema.json`.
3. Validate three fixtures against it with ajv:
   - `seed-current.json` — the literal clawops writes today
     (`{"meta":{"lastTouchedVersion":"2026.4"},"gateway":{"port":18789,"auth":{"mode":"token"}},"models":{},"channels":{}}`)
   - `overlay-realistic.json` — a deep-merged plan overlay with channels and model providers
   - `seed-proposed.json` — the shape WO-40/41 propose
4. Boot the gateway with each config and record whether it starts.
5. Boot with the config bind-mounted `:ro` and record the failure mode.

## Result

_pending — image pull in progress_

## Assertion to graduate (§5)

Config validation fixtures against the committed schema: valid, unknown-key, missing
`gateway.mode`, stale `meta`. Runs in unit tests with no VM and no network.
