# SP-07 — 1.x → 2.0 migration

**Status:** COMPLETE — 2026-09-04. EC2 spot `t3.medium`, x86_64, Ubuntu 24.04.4.
1.x deployment stood up exactly as clawops v1.7.x builds it (`2026.7.1`, config mounted at
`/app/config.json:ro`, no state volume), then migrated to `2026.8.1`.

**Verdict: migration works, but not as WO-52 was drafted.** Two assumptions in the plan are wrong,
and one of them changes who can be migrated at all.

---

## Finding 1 — there is nothing on the host to migrate

WO-52 was drafted as "detect the 1.x layout → relocate config and state into the new volume layout".
There is no 1.x host layout to relocate:

```
inside container : identity  state  workspace      (2.8 MB, state/openclaw.sqlite)
on host          : openclaw.json                   (ignored — see G3)
```

**All 1.x state lives inside the container.** The migration must extract it from the *running*
container (`docker cp`, or `openclaw backup create` inside it — verified present in 2026.7.1) before
that container is destroyed. A migration that stops the container first destroys what it came to
save.

### The uncomfortable corollary

`clawops gateway restart`, `clawops gateway update` and `clawops config set` all do `docker rm` +
`docker run`. On the 1.x line **every one of those has been silently destroying user state all
along** — not just on upgrade. Many users will have nothing meaningful to migrate, and `clawops
migrate` should say so honestly rather than implying it rescued something.

## Finding 2 — 1.x has no config to carry forward

The extracted state contains no `openclaw.json`; 1.x never wrote one (the config was mounted
separately and ignored). 2.0 then blocks:

> `Missing config. Run 'openclaw setup' or set gateway.mode=local (or pass --allow-unconfigured).` → exit 78

**WO-52 must synthesise a valid 2.0 config**, not migrate one. Its source of truth is the deploy
plan plus whatever the user had in the ignored `/home/clawops/openclaw.json` — which should be
treated as *intent to review*, never applied blindly, since it has never been in force and may not
validate against 2.0 (channel blocks certainly will not — G15).

## Finding 3 — the state migration itself is clean

With the state volume mounted, 2.0 ran its upgrade pass automatically:

```
[state-migrations] Legacy state migration notes:
  - Migrated shared state audit event ledger → versioned message lifecycle schema
  - Migrated shared state tables to SQLite STRICT typing (48)
  - Migrated primary device identity to SQLite.
```

After synthesising a config: `running`, `/startupz {"ok":true,"status":"started"}`, and healthy again
after a further container replacement. **No `doctor --fix` fallback was needed** — the startup-safe
migration path did the work, as upstream documents.

## Sequence that works

1. Extract state from the **running** 1.x container → host directory
2. `chown -R 1000:1000` (G25 — numeric, not `clawops:clawops`)
3. Stop and remove the 1.x container
4. Synthesise a valid 2.0 `openclaw.json` (`gateway.mode: local` at minimum)
5. Start 2.0 with the state volume, `OPENCLAW_CONFIG_PATH`, and `OPENCLAW_GATEWAY_TOKEN`
6. Gate on `/startupz`; on failure run the documented one-shot `doctor --fix`
7. Report what carried over and what needs operator attention

## Open item — device identity continuity

`identity/` is emptied by the migration ("Migrated primary device identity to SQLite"), which is
expected 2.0 behavior rather than loss. **I did not independently verify the `deviceId` value
survived** — `openclaw devices list` reports "No device pairing entries" on this install, so there
was nothing paired to prove continuity against.

This matters: if `deviceId` changes, paired nodes and devices need re-pairing. WO-52 must verify
identity continuity on an install that actually has pairings, and say so in its report if they must
be re-established.

Note also that a changing `state/openclaw.sqlite` file hash is **not** evidence of state loss — the
DB is written on every start. The reliable instrument is the install fingerprint
(`config-journal-fingerprint.key`), which is what SP-01 used.

## Assertions to graduate

1. Migration extracts state from a running container, never a stopped one. *(VM)*
2. Synthesised config validates against the captured 2.0 schema before the container starts. *(unit)*
3. Post-migration `/startupz` returns started. *(VM)*
4. Install fingerprint is stable across a post-migration container replacement. *(VM)*
5. `clawops migrate` refuses to run without a verified backup. *(unit)*
