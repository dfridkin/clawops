# OpenClaw 2.0 support — migration plan

**Status:** re-cut 2026-09-04, after all 8 spikes. §4 is verified against a real host, not inferred.
**Target:** clawops **v2.0.0** (`main`) + a maintained **`1.x`** line (published: v1.7.1)
**Upstream floor:** OpenClaw **`2026.9.1`** — *not* 2026.8.1; see G27
**Pre-2.0 ceiling:** OpenClaw `2026.7.1-2`
**Evidence:** [`docs/spikes/`](spikes/) — SP-01 … SP-08
**Sources:** [release notes](https://docs.openclaw.ai/releases/2026.8.1) · [Docker install](https://docs.openclaw.ai/install/docker) · [Configuration reference](https://docs.openclaw.ai/gateway/configuration-reference) · [Sandboxing](https://docs.openclaw.ai/gateway/sandboxing) · [Fleet](https://docs.openclaw.ai/cli/fleet) · upstream `Dockerfile` + `docker-compose.yml`

---

## 1. Verdict

**clawops v1.7.x cannot deploy OpenClaw 2.0.** Reproduced on x86_64 Ubuntu 24.04: run the current
path unmodified against `2026.8.1` and the container **crash-loops on first deploy** — exit 78, five
restarts and climbing, `Refusing to bind gateway to auto without auth`.

The first draft of this plan got the mechanism wrong in an instructive way, and the spikes corrected
it twice over.

**It is loud, not silent.** The original verdict rested on "the container reports healthy while being
unreachable". That failure mode does not exist: OpenClaw 2.0 detects a container environment and
binds `0.0.0.0`, so the documented loopback default never applies to us. What happens is an obvious
crash-loop — a better failure than a silent one.

**The worst defect was never a 2.0 problem at all.** `~/.openclaw/openclaw.json` does not exist in a
running container; `/app/config.json` — the path clawops mounts — is read by nothing. A config
declaring `gateway.port: 19999` is ignored by **both** `2026.7.1` and `2026.8.1`; both bind 18789.
**`clawops config set` has never delivered configuration to the gateway, on either OpenClaw line.**
Models, channels, auth mode: all silently discarded, today, on the shipping product. Deployments work
only because the auth token arrives on the command line.

Two more findings reshape the work rather than confirm it:

- **State has always been ephemeral.** Nothing is mounted but the config file, so `gateway restart`,
  `gateway update` and `config set` — all of which `docker rm` — have been destroying sessions,
  transcripts and credentials on the 1.x line all along.
- **A headline feature cannot run on our intended floor.** Bedrock is now a ClawHub plugin whose API
  requires `>=2026.9.1`; configuring it without the plugin makes the gateway refuse to start.

**Framing (D1): two release lines, one runtime contract each.** clawops `2.x` targets OpenClaw
`>= 2026.9.1`; a maintained `1.x` stays pinned to `<= 2026.7.1-2`. Neither branch carries both.

The pin is only real if it is enforced — §2.

---

## 2. Ship first — v1.7.2

`spec/openclaw-versions.yaml` declares `support.max: ""`. **The published clawops accepts any
OpenClaw version**, upstream's `latest` has already moved, and anyone on `"latest"` or `"stable"` is
one `clawops up` from a crash-looping gateway.

Design is parked in [`docs/spikes/v1.7.2-pr-design.md`](spikes/v1.7.2-pr-design.md); every mechanism
is verified on both `2026.7.1` and `2026.8.1`.

1. **Version ceiling** — `support.max: "2026.7.1-2"`; refuse in `doctor`, plan validation, `up`,
   `apply`. Resolve `latest`/`stable` to a concrete version **before** the range check. The error
   names the fix and points at **2.x for `>= 2026.9.1`**.
2. **Detect-and-warn** on deployments already running 2.x — inspect the *running* container's image
   tag; gating future operations does nothing for someone already broken.
3. **Config delivery (G3)** — `-e OPENCLAW_CONFIG_PATH=/app/config.json`. Verified to make both lines
   honour config. Guarded four ways: normalise `gateway.port` to 18789 with a warning, pin
   `--port 18789` on argv (verified to override config), skip delivery if the file will not parse,
   and health-gate the result with a revert to the prior command.
4. **Ollama (G23)** — `--add-host=host.docker.internal:host-gateway` (verified: resolves to
   `172.17.0.1`; absent otherwise) plus the corrected `baseUrlDefault`. Depends on #3.

Items 3 and 4 touch all six `docker run` sites. Keep the edits mechanical; consolidation is WO-38's
job on the 2.x line, and mixing a refactor into a patch is how this gets risky.

---
## 3. What changed upstream

Filtered to provisioning, config, state, network and lifecycle. The 16,000-PR long tail is
irrelevant to clawops.

- **State moved to SQLite.** Sessions, transcripts, auth profiles and the shared credential store all
  live under the state directory. A state volume is mandatory, and downgrade past the migration is a
  one-way door.
- **Config is `~/.openclaw/openclaw.json`** (JSON5), or `OPENCLAW_CONFIG_PATH`. Validation is strict —
  unknown keys make the gateway refuse to start. Startup *writes* the file (migrations, `.bak` ring,
  last-known-good), so the mount must be writable.
- **Providers are plugins.** Only `anthropic` and `openai` are bundled. Bedrock, Mistral, Cohere and
  the rest install from ClawHub with capability consent — and a configured-but-missing provider
  **blocks startup**.
- **`codex/*` and `openai-codex/*` routes retired** → `openai/*`; default `openai/gpt-5.6-sol`.
- **Bedrock's shape changed** to `auth.profiles.<id>.mode: "aws-sdk"`. The `AWS_PROFILE`-in-
  EnvironmentFile quirk recorded in `CLAUDE.md` is obsolete.
- **Lifecycle:** `OPENCLAW_SUPERVISOR_MODE=external` hands restarts to us; image upgrades run
  startup-safe migrations and exit rather than report healthy if they fail; `doctor --lint --json` is
  the documented preflight; first-class `openclaw backup`.
- **Probes:** `/healthz`, `/startupz`, `/readyz`, unauthenticated.
- **Container contract:** `node:24-bookworm`, runs as `node` **uid 1000**, `CMD ["node","openclaw.mjs","gateway"]`,
  state `/home/node/.openclaw`, ports 18789 / 18790 / 3978, token via `OPENCLAW_GATEWAY_TOKEN`.

---

## 4. Gap analysis — verified

All 8 spikes complete. **Two P0s refuted, four new gaps found, two upgraded, one floor moved.**
Evidence in [`docs/spikes/`](spikes/).

### P0 — blocking

| # | Defect | Status | Effect |
|---|---|---|---|
| **G3** | clawops config is read by nothing. `/app/config.json` unread; `OPENCLAW_CONFIG_PATH` unset. Verified on **both** lines: config says port 19999, both bind 18789. | ✅ **confirmed, upgraded** | **`clawops config set` has never worked.** Not a 2.0 regression — a latent bug in the shipping product. Fix verified: one env var. |
| **G2** | No state volume; `state/openclaw.sqlite` lives only inside the container. | ✅ confirmed | Install fingerprint changes across replacement — all state lost. Happens on every `restart`/`update`/`config set`. |
| **G27** | **Provider plugins are consent-gated and not bundled.** Configuring Bedrock without installing `clawhub:@openclaw/amazon-bedrock-provider` → `plugin verification failed`, exit 1. The plugin needs API **>=2026.9.1**. | 🆕 **new** | clawops's AWS adapter makes Bedrock first-class, so on 2026.8.1 that path yields a gateway that will not start. **Moves the floor to 2026.9.1.** |
| **G1′** | No gateway token on first boot → `Refusing to bind gateway to auto without auth`, exit 78. | ✅ confirmed | Infinite crash-loop under `--restart unless-stopped`. |
| **G25** | **uid mismatch.** `ubuntu` holds uid 1000 on cloud images, so our `clawops` user gets 1001; the container runs as 1000. | 🆕 **new** | State dir owned by 1001 → `EACCES … openclaw.sqlite-wal`, exit 1. We chown by name in three places. Ownership must be **numeric**. |
| **G15** | Channel configs are schema-invalid: Discord's field is `token` not `botToken`; every channel requires `dmPolicy` and `groupPolicy`; `additionalProperties: false`. | ⬆️ P1→**P0** | Any deployment configuring a channel produces a rejected config. |
| **G5** | Permanent `--allow-unconfigured`; missing `gateway.mode` → exit 78. | ✅ confirmed | Never reaches a supported configured state. |
| **G6** | Token on argv. | ✅ confirmed — **load-bearing** | Given G3, this is the *only* reason deployments work. Visible in `ps`/`docker inspect`. |
| **G7** | `ghcr.io/anthropics/openclaw` in the Pulumi component. | ✅ confirmed, **downgraded** | Pull fails, but nothing constructs `Gateway` — only its own test does. Dead code, so no user hits it. It is a trap for whoever wires it up next; fixed or deleted under WO-38. |

### Refuted — the plan was wrong

| # | Claim | Finding |
|---|---|---|
| **G1** | "Binds loopback in-container; published port silently unreachable." | ❌ **Refuted.** `Container environment detected — the gateway defaults to bind=auto (0.0.0.0)`. `--bind lan` unnecessary. |
| **G4** | "Seed config is schema-invalid." | ❌ **Refuted.** It validates, `meta.lastTouchedVersion: "2026.4"` included. The blocker is missing `gateway.mode` (G5). |

### P1

| # | Gap | Status |
|---|---|---|
| **G26** | `openclaw config schema` emits 9 dangling `#/$defs/` refs from two plugin sub-schemas; will not compile as published. Rebasing onto the nearest ancestor `$defs` resolves all 9. | 🆕 new — WO-36 needs a normalisation pass |
| **G28** | **Plugin/runtime version skew.** The Bedrock plugin advertised v2026.9.1 against a v2026.8.1 runtime and refused. | 🆕 new — `models.yaml` must record a minimum runtime per plugin |
| **G23** | Ollama default `localhost` unreachable from the container; `--add-host` never existed in the repo. | confirmed — **not** fixed by `9ea10ff`, which changed only prompt wording |
| G10 · G11 · G12 · G13 · G14 · G16 · G17 · G22 | Health checks, backup of live SQLite, no post-upgrade repair, supervisor conflict, stale catalog, hardcoded ports, Node drift, plaintext OAuth at rest | carried forward; not spike-covered |

WO-58's systematic audit still applies — the spikes covered runtime and config, not the remaining ~22 files.

---
## 5. Work orders

Sizes are T-shirts (S / M / L), not estimates. **v2.0.0 ships Phases 0–3 plus WO-49.**

### Phase 0 — ground truth and release structure

**WO-50 — Cut the two release lines** *(D1 — M)* — ✅ **done**
Branched `1.x` at **v1.7.7**. Dist-tag is **`legacy`**, not `v1`: npm refuses any dist-tag that
parses as a SemVer range, and `v1`, `v1.x` and `1.x` all parse as `>=1.0.0 <2.0.0-0`. One
`release.yml` serves both branches; MCP registry publishing is restricted to `main`, since the
registry serves one current version per server. EOL **2027-03-31** recorded in `SECURITY.md` and
`docs/support-matrix.md`. Original text follows.


Branch `1.x` from v1.7.2; `main` becomes 2.x. Dist-tags `latest` → 2.x, `v1` → 1.x. Decide three
things rather than gesture at them: the **EOL date — decided: 2027-03-31 (end of Q1 2027)**,
recorded as a date in `SECURITY.md` and `docs/support-matrix.md` rather than a duration; backport scope (security + provider-adapter fixes only), and **which gaps apply to `1.x`** —
**which gaps apply to `1.x`** — re-checked against shipped code, not the original
survey: **G3 was fixed in v1.7.2** (config delivery); **G7 survives only in the unreachable Pulumi
`Gateway` component**, so no user is exposed. Branch point is **v1.7.6**, not v1.7.2 — v1.7.5 and
v1.7.6 both fixed live defects. The npm OIDC publish path is fussy; budget for it, and note that
publishing from `1.x` must pass `--tag v1` or it will steal `latest` back from 2.x.

**WO-58 — Systematic gap audit** *(M)* — ✅ **done** → [`docs/openclaw-2.0-gap-audit.md`](openclaw-2.0-gap-audit.md)
All 30 files read against the measured contract. Two results change Phase 1: **WO-38 grows** (the
config mount must become a directory across four sites — a shape change, not a value change), and
**WO-39 does not shrink** (state persistence is absent everywhere, not partial). One prerequisite is
outstanding: **`clawops agents restart` and `clawops agents logs` break outright** — 2.0 removed
both subcommands, and the only replacements are gateway-wide, so this needs a product decision
rather than a port.

30 files reference `openclaw`; the spikes covered the runtime and config surfaces. Read the rest
against the 2.0 contract. **Phase 1 is not scoped until this lands.**

Findings so far, by where they landed:

| Finding | Where | Disposition |
|---|---|---|
| G29 `openclaw-ctl` is not a binary | backup, MCP agents | fixed, v1.7.5 |
| G30 restart paths pass no gateway command | `gateway restart`/`update`, `config set` | fixed, v1.7.5 |
| G31 backup flags wrong; no `restore` upstream | backup | fixed, v1.7.5 |
| **G32** MCP `clawops_gateway_restart` hand-rolled its own run command — same defect as G30, missed by the v1.7.5 sweep | `src/mcp/tools/cli/gateway.ts` | fixed, v1.7.6 |
| **G33** restart paths fell back to `:latest`/`:stable` when no container was found — resolving to 2.0, *past* the version guard | 3 restart paths | fixed, v1.7.6 |
| G7 wrong registry | `src/pulumi/components/gateway.ts` | dead code → WO-38 |
| Port hardcoded in 16 files | widespread | WO-42 / WO-48 |
| `logs.ts` assumes a `journalctl -u openclaw` unit only the local provider creates | `src/cli/commands/logs.ts` | 2.0; falls through to `docker logs` by accident today |
| `monitor.ts` reads `/home/clawops/openclaw.json` directly | `src/cli/commands/monitor.ts` | WO-39 |

**Method note.** G32 and G33 were found by enumerating *every* site that starts a gateway container
and asking which lacked the command — not by reading the diff of the previous fix. The v1.7.5 sweep
missed them because it followed the three paths a bug report named. Enumerate the surface, then
check each element; do not follow the trail of the last defect.

**WO-36 — Capture and normalise the config schema** *(S)* — ✅ **done**
Captured from `2026.9.1`. G26 confirmed: 9 refs, 7 distinct targets, **no root `$defs` at all**, and
ajv refuses the document outright (`can't resolve reference #/$defs/account from id #`).

The diagnosis is narrower than "dangling refs". The definitions **do** exist — nested under the two
plugins that own them (`plugins.entries.imap.config.$defs`, `…webhooks.config.$defs`). Upstream
inlines each plugin's schema into the parent without hoisting its `$defs` or rewriting the pointers
inside it, so root-relative refs point at definitions several levels down.

`scripts/openclaw/normalise-schema.mjs` rebases each ref onto the **nearest ancestor** that defines
it, rather than hoisting to a shared root `$defs`. On 2026.9.1 the two shared names (`secretRef`,
`secretInput`) are byte-identical between the plugins, so hoisting would work today — and would
silently merge them the first release they diverge, pointing each plugin's refs at the other's
shape. The script refuses rather than guesses when a ref matches no ancestor.

987 KB minified, compiles in ~0.9 s, idempotent. Drift is a weekly workflow, not a PR check: the
image is 3.2 GB.

**The schema is necessary, not sufficient — and this is the load-bearing result.** A config with no
`gateway.mode` passes this schema *and* passes `openclaw config validate`, then exits **78** on
startup:

> Gateway start blocked: existing config is missing gateway.mode. Treat this as suspicious or
> clobbered config. Re-run `openclaw onboard --mode local` or `openclaw setup`, set
> gateway.mode=local manually, or pass `--allow-unconfigured`.

All three observed on 2026.9.1. So schema validation cannot be promoted into a startup guarantee,
and a test asserts that so nobody does.

**WO-37 — Rewrite `spec/openclaw-versions.yaml`** *(S)* — ✅ **done, with one deliberate deviation**
Added the `runtime:` block (image, variants, paths, ports, env names, startup contract, per-provider
plugin facts) as WO-38's machine-readable source, rewrote `incompatible` from measurements, and
retired the obsolete Bedrock/systemd quirk in favour of the 2.0 plugin-install quirk.

**`support.min` was NOT flipped to 2026.9.1, and must not be until WO-40.** The work order as written
would have inverted the guard. `support.min`/`max`/`recommended` are enforced live by `up`, `plan`,
`apply` and `doctor`; the runtime code is still 1.x-shaped. Flipping now makes clawops refuse
`2026.7.1-2` — the only version it can deploy correctly — and accept `2026.9.1+`, which it would
deploy with the 1.x contract and crash-loop. Exactly the failure the guard exists to prevent.

Instead the file carries `line: "1.x"`, and `tests/openclaw/line-interlock.test.ts` gates the flip:
setting `line: "2.x"` fails CI until the runtime writes `gateway.mode` and stops passing
`--allow-unconfigured`. Verified by flipping it — the suite fails with *"the 2.x line must not depend
on --allow-unconfigured"* — and restoring.

### Phase 1 — runtime contract

**WO-38 — One runtime contract, one builder** *(L — the critical path)*
`src/openclaw/runtime.ts` owns image ref, paths, ports, env names, and a single command builder driven
by the spec. Replaces all six hand-written `docker run` strings and the Pulumi component. Adopts
Fleet's profile, **validated against a live cell** (SP-06): loopback publishing, `--cap-drop=ALL`,
`--init`, pids/memory/cpu limits, a dedicated bridge network. Roughly 60% of the value for 15% of the
effort.

**WO-39 — Persist state** *(G2, G3, G25 — M)*
Mount the **config directory**, not the config file — atomic rename over a bind-mounted file fails
`EBUSY`, which blocks `plugins install` outright (SP-10b §4). Pre-installed plugins then persist
inside that directory, so no separate plugin volume is required (SP-10b §5).

Host `/var/lib/clawops/openclaw` at the **standard** container path `/home/node/.openclaw` — SP-01
proved identity mapping unnecessary here, and the standard path matches upstream and Fleet. Drop
`:ro`, drop `--rm`, mount the auth-profile secret dir and a persistent `/home/node`.
**Ownership must be numeric (uid 1000), never `clawops:clawops`** (G25).
*Exception:* when sandboxing is enabled the state dir **must** be identity-mapped (SP-04) — see WO-53.

**WO-40 — Auth and startup posture** *(G1′, G5, G6, G7, G13 — M)*
**Write `gateway.mode: "local"` and stop passing `--allow-unconfigured`.** Measured on 2026.9.1:
with `mode` present the gateway starts *without* the flag; with the flag it starts regardless of
what the config says. Today clawops writes no `mode` and passes the flag, so it depends on the
escape hatch permanently — and that hatch exists to bypass a check upstream describes as detecting
"suspicious or clobbered config". Keeping it means clawops can never notice a clobbered config.

**The token is the fix, not the bind mode.** Supply it via `OPENCLAW_GATEWAY_TOKEN`, never argv.
Write `gateway.mode: "local"` into the config the gateway actually reads; drop `--allow-unconfigured`
from the steady state. **Pin `--port` on argv** so config can never move the listener. Fix the
registry typo. Set `OPENCLAW_SUPERVISOR_MODE=external`. Publish to `127.0.0.1:<port>` only —
SP-01 confirmed `clawops tunnel` reaches it while the LAN address and internet do not, so the firewall
need not open 18789 at all. **Breaking change:** anyone hitting `:18789` directly loses that path —
migration-guide entry plus a `spec.network.publish` escape hatch.

**WO-51 — Enforce the version pin both ways** *(G9 — S)*
`2.x` refuses `< 2026.9.1`; `1.x` refuses `>= 2026.8.1`. Resolve `latest`/`stable` **before** the
range check — resolving after is how the unbounded ceiling survived.

### Phase 2 — config, plan, catalogs

**WO-41 — Validate before writing** *(G4-adjacent — M)*
ajv against the WO-36 schema before `atomicWriteConfig`; respect the clobber guards; surface
`<path>.rejected.<timestamp>`; add `clawops config validate`.

**WO-42 — Deploy-plan schema v2** *(G16 — M)*
`spec.openclaw.{workspace,permissionMode,plugins[],image.variant}`, `spec.network.ports[]` and
`spec.network.publish`, plus extra-mount fields. Migration path for existing `clawops.dev/v1` plans.

**WO-43 — Catalogs, and provider plugins at bootstrap** *(G8, G14, G15, G27, G28 — L, was M)*
Bigger than first scoped, because provider plugins are **startup-blocking**:
- Install and consent provider plugins during bootstrap, before first gateway start
  (`plugins install clawhub:… --accept-capabilities`), with per-plugin minimum runtime (G28).
- `models.yaml`: `openai/*` routing, `gpt-5.6-sol` default, provider→package mapping,
  `modelPolicy.allow`, Bedrock via `auth.profiles.<id>.mode: "aws-sdk"`.
- `integrations.yaml`: correct per-channel token fields, required `dmPolicy`/`groupPolicy`, SecretRef
  credentials, per-channel plugin package and port needs.
- **New egress dependency: ClawHub** — feeds `/audit-egress` and the firewall notes.
- Ollama via `host.docker.internal` + `--add-host` (G23).

### Phase 3 — lifecycle

**WO-44 — Real health checks** *(G10 — M)* — `/startupz` gates apply; `/readyz` drives status and
monitor; `docker inspect` becomes a fallback. Add `doctor --lint --json` as post-apply preflight.

**WO-45 — Upgrade, repair, rollback** *(G12 — M)* — verified backup → image swap → `/startupz` gate →
one-shot `doctor --fix` on failure. Refuse downgrade across the SQLite boundary. SP-07 found the
startup-safe path handled a real 1.x→2.0 migration with **no** `doctor --fix` needed, so treat the
fallback as exceptional rather than routine.

**WO-46 — Delegate backup** *(G11, G22 — M)* — `openclaw backup create --verify` over SFTP; restore
into a staging dir, never in place. Archives carry plaintext OAuth — say so, restrict permissions.

**WO-52 — `clawops migrate`** *(D2 — L; rewritten after SP-07)*
The drafted sequence was wrong in two ways:
1. **There is no 1.x host layout to relocate.** All 1.x state is *inside the container*. Migration must
   extract from the **running** container; stopping it first destroys what it came to save.
2. **There is no config to carry forward.** 1.x never wrote one, and 2.0 then blocks with
   `Missing config` → exit 78. Migration must **synthesise** a valid 2.0 config from the deploy plan,
   treating the old ignored `/home/clawops/openclaw.json` as *intent to review* — never applied
   blindly, since it has never been in force and its channel blocks will not validate.

Verified sequence: extract → `chown 1000:1000` → stop/remove → synthesise config → start with state
volume + `OPENCLAW_CONFIG_PATH` + token → gate on `/startupz` → report. Must refuse without a verified
backup, and must **verify device-identity continuity** — identity moves into SQLite during migration,
and if `deviceId` changes, paired devices need re-pairing (SP-07 could not confirm this on an install
with no pairings).

It should also say plainly when there was nothing to rescue: given G2, any user who ran
`gateway restart`/`update`/`config set` already lost their state.

### Phase 4 — surface, hardening, release

**WO-47 — MCP tool surface** *(S)* — declare in `spec/mcp-tools.yaml` first; add
`clawops_openclaw_doctor`; all four annotation hints; 8 KB trim with the full report as a resource.

**WO-48 — Plan-driven firewall** *(G16 — S)* — ports from the plan, not module constants. With
loopback publishing, the default set may be **SSH only**.

**WO-49 — Documentation audit and release** *(L)* — §9.

### Deferred to clawops 2.1

**WO-53 — Agent sandboxing** *(D4 — L)* — feasible (SP-04), and **no clawops-published image is
needed** (SP-09). Mount Docker's own statically-linked CLI into the **unmodified official image**:
verified `CLI 28.5.2 -> daemon 25.0.16`, sandbox backend active, sibling containers spawned from
inside the gateway with `cap-drop=ALL` and `network=none`. The derived image (SP-03, +70 MB) stays
as the fallback for hosts that cannot reach `download.docker.com`. Plus socket mount and a
runtime-read docker gid; sandbox image built on the host; **state dir identity-mapped** — without it
the agent silently gets an empty workspace and root-owned junk accumulates on the host. Wizard
question states the socket tradeoff in one sentence.
**WO-54 — Config surface for roles, agents, credential store, telemetry** *(M)*
**WO-56 — Observability plugins** *(S)*
**WO-55 — TLS and public origin** *(XL)* — gates Portals, Teams, Slack, Discord Activities.
**WO-57 — Fleet multi-tenancy** *(L)* — unblocked: SP-05 proved the containerised CLI works.

### ADRs

| ADR | Subject |
|---|---|
| `0010-openclaw-2-runtime-contract.md` | State volume, writable config, env-var token, loopback publishing, numeric ownership |
| `0011-dual-release-lines.md` | Two lines, dist-tags, backport scope, EOL date |
| `0012-writable-config-mount.md` | What replaces read-only config as a safety property |
| `0013-docker-only-runtime.md` | Docker-only, and how each capability gap is closed inside it |
| `0014-sandbox-docker-socket.md` | **R-meta-3** — socket mount vs. N10 and the harden posture |

---
## 6. Testing

**The spikes are the regression suite.** Each SP write-up ends in assertions; land them as tests in
the PR that resolves the work order. A spike whose result is not encoded is a fact we will
rediscover.

**They cannot run on the current harness.** `tests/integration/helpers/ssh-container.ts` uses a
container as a stand-in for a VM; the two assertions that matter most — reachability through a
published port and state survival — would pass **vacuously**. Either add a VM-backed CI job, or move
them to `docs/smoke-testing.md` as manual release gates and say plainly CI does not cover them.

**Unit (no VM)** — rendered `docker run` per provider: state volume mounted, no `:ro` on config,
ownership numeric, `OPENCLAW_CONFIG_PATH` set, `--port` pinned, `--add-host` present, identity-mapped
only when sandboxed · config fixtures against the captured schema · catalogs · plan v1→v2 · version
range with `latest`/`stable` resolution order · Bedrock emits a plugin-install step.

**Pulumi mocks** — exact type tags (`aws:ec2/instance:Instance`).

**VM-backed (graduated)**

| Test | From | Asserts |
|---|---|---|
| Reachable through the published port | SP-01 | `/startupz` 200 |
| State survives replacement | SP-01 | install fingerprint stable — **not** the sqlite file hash, which changes every start |
| Config written is config read | SP-01 | G3 regression |
| Clean apply passes upstream preflight | SP-02 | `doctor --lint --json` ok |
| 1.x → 2.0 migration | SP-07 | sessions present, `/startupz` started |
| Bedrock instance-role resolution | SP-08 | AWS-only |

**Provider coverage** — the matrix is four adapters × sandboxed/not × migration and remains unsized.
Minimum honest position for v2.0.0: unit and Pulumi-mock coverage on all four, VM-backed on `local`,
AWS exercised by hand per `docs/smoke-testing.md` before release. GCP and Azure ride on WO-38's shared
builder, which is the argument for centralising it.

---

## 7. Sequencing

```
v1.7.2   ceiling + detect-warn + config delivery + Ollama     ← ship now, 1.x line
            │
Phase 0  WO-50 ─ WO-58 ─ WO-36 ─ WO-37
            │
Phase 1  WO-38 ─ WO-39 ─ WO-40 ─ WO-51            ← P0 clear
            │
Phase 2  WO-41 · WO-42 · WO-43
            │
Phase 3  WO-44 ─ WO-45 ─ WO-46 ─ WO-52            ← WO-52 is the adoption gate
            │
Phase 4  WO-47 · WO-48                             (parallel with 3)
            └─ WO-49 ─ v2.0.0

2.1      WO-53 · WO-54 · WO-56 · WO-55 · WO-57
```

Critical path **WO-38 → WO-39 → WO-40 → WO-51 → WO-41**. Three L work orders carry the release —
WO-38, WO-43, WO-52 — plus WO-49, which is documentation.

### Why feature parity is 2.1

v2.0.0 would otherwise rewrite the runtime contract *and* take on a permanently maintained container
image for a feature that ships off by default. The emergency is: deployments work again, and existing
users can get across. **Note WO-43 is *not* deferred** — but the reason has changed.

**Correction (SP-10).** "Provider plugins are install-gated; a configured but uninstalled provider
prevents startup entirely" was recorded from 2026.8.1. On 2026.9.1 the behaviour is worse, not
better, because it is quieter:

| Egress | Result |
|---|---|
| available | plugin auto-installed from ClawHub → gateway **exits 1** ("startup convergence") → next boot converges, `restarts=1` |
| denied | gateway starts **healthy, without the provider** — no error, no failed health check |

clawops defaults to deny-all egress, so the silent case is the default one. And the install lands in
the container's writable layer, so **every** `gateway restart`/`update`/`config set` — all of which
`docker rm` the container — refetches it and pays another convergence restart. Measured.

WO-43 stays in v2.0.0, and SP-10b settles its design — correcting two things this plan said an
hour earlier:

1. **Pre-install at provisioning**, into the config directory. Plugins installed explicitly land in
   `<configDir>/extensions/`, not `/app/npm/projects`, so they persist with the config directory
   clawops already keeps as host state. **No extra volume is needed** — the earlier note to persist
   `/app/npm/projects` aimed at the path the *startup auto-install* uses, which is the mechanism we
   are avoiding.
2. **Verify with `plugins list --json`, reconciling `providerIds`.** Not `plugins doctor`: it never
   names a missing provider and exits 1 on duplicate-id warnings during normal operation, so it
   fails when nothing is wrong and stays quiet when something is.

Measured end to end — pre-installed, then booted with `--network none`: `restarts=0`, bedrock
`status: loaded`, nothing fetched at boot.

**Two constraints fall out of this and bind WO-38/39:**

- **The floor is `2026.9.2`, not `2026.9.1`.** The official Bedrock plugin declares
  `requires plugin API >=2026.9.2` and refuses to install on 9.1.
- **Mount the config directory, never the config file.** OpenClaw writes config by atomic rename,
  and renaming over a bind-mounted file fails `EBUSY` whether mounted `:ro` or `rw`. clawops mounts
  the file today, so `plugins install` cannot work at all until this changes.

v2.0.0 ships against a gateway advertising sandboxing, roles and observability that clawops cannot
configure. The docs must name that (§8.3); silence reads as a bug.

---

## 8. Decisions — resolved

| # | Question | Decision |
|---|---|---|
| **D1** | Drop 1.x or dual-support? | **Two lines, pinned.** 2.x → `>= 2026.9.1`; 1.x → `<= 2026.7.1-2`. WO-50 + WO-51. |
| **D2** | Automated migration? | **Yes — `clawops migrate` (WO-52)**, rewritten after SP-07. |
| **D3** | Docker-only, or add the native path? | **Docker-only**, closing each capability gap inside Docker. ADR 0013. |
| **D4** | Support sandboxing despite the harden tension? | **Yes — opt-in, explicit wizard question.** Feasible per SP-04. WO-53, ADR 0014. |

### 8.1 What Docker-only costs

Eight capabilities need work under a container gateway; all eight are closable inside Docker.
Sandboxing is WO-53; Claude CLI auth needs the persistent home; host-local models need
`host.docker.internal`; the browser tool needs the `-browser` variant; skill deps need the derived
image; memory imports need extra mounts; Bonjour is irrelevant on cloud VMs; native service
management is a *benefit*, since we own the lifecycle.

### 8.2 Fleet — validated

SP-06 confirmed the documented cell profile **matches reality exactly** (cap-drop ALL,
no-new-privileges, init, pids 512, 2 g, 2 cpu, loopback publishing, per-cell network, standard
container path). Adopt it for the single-tenant path — that is §5's WO-38, costing nothing.

SP-05 resolved WO-57's blocker: `openclaw fleet` **runs containerised** with `--network host`, the
docker socket, a runtime-read docker gid, and an identity-mapped state dir. No host `npm i -g
openclaw`; ADR 0013 stands. Two traps: without `--network host` the CLI fails its own health gate
while the cell is genuinely healthy, and Fleet defaults to the unpinned `:latest` tag.

Fleet and sandboxing remain mutually exclusive per host — a sandboxed cell holding the socket can
reach sibling cells, destroying the tenant boundary. Encode as plan validation, not a doc sentence.

### 8.3 Feature coverage

**Free** once Phases 1–2 land: conversation search, shared sessions, progress cards, structured
questions, widgets, private credential prompts, approve-once automations, memory, self-learning,
channels and clients. **v2.0.0:** permission modes, model allowlists, provider packages, backups,
external supervision, local inference sizing. **v2.1:** sandboxing, roles, named agents, credential
store, telemetry, observability. **Later:** Portals/Teams/Slack/Discord Activities (need WO-55),
cloud workers, paired nodes. **Won't:** Swarm (experimental toggle, no infra surface).

---
## 9. Documentation audit

This release changes the runtime contract, the support model and the security posture, so the living-
documentation table is necessary but not sufficient — a doc can be silently wrong without matching any
trigger row. WO-49 is an **audit with a tracked inventory**: 44 documents.

**Fix first — `CLAUDE.md` and `AGENTS.md`.** Their Quirks section states that *"OpenClaw 2026.4.5+
requires `AWS_PROFILE` in the systemd EnvironmentFile, not `auth: "aws-sdk"`"*. SP-08 proved the 2.0
form is `auth.profiles.<id>.mode: "aws-sdk"`, so this is false — and it is loaded into every agent
session on this repo, steering future work wrong.

**Rewrite** (the stated contract changed): `limitations.md` (Docker-only consequences, features gated
on TLS, the Codex/AppArmor userns constraint, and that clawops now *does* write config) ·
`support-matrix.md` (a range **per line**, floor 2026.9.1, Node 24) · `upgrade-rollback.md` (one-way
door, restart-loop, recovery) · `backup-restore.md` (delegate; archives are credential-bearing) ·
`plan-apply.md` (schema v2) · `configuration.md` (path, JSON5, strict validation, hot reload) ·
`operations.md` (probes, `doctor --lint`) · `security/threat-model.md` (socket, plaintext OAuth,
Fleet trust model, loopback publishing) · `security/redaction.md` · `providers/matrix.md` ·
`README.md` · `SECURITY.md` (*"only the latest minor version receives security patches"* is
incompatible with a maintained 1.x line).

**Update:** architecture · secrets · telemetry · logging · smoke-testing · development · ci ·
generated-files · roadmap · SPEC · providers/{aws,gcp,azure,local} · mcp/* ·
security/{tool-risk-matrix,mcp-safety,audit-logs} · demo-script · examples/* · CONTRIBUTING (backport
policy) · DESIGN_RULES (N10 as plan-driven).

**Skills:** `openclaw-config` (encodes the old config model) · `release` (two-line publish) ·
`audit-egress` (**new: ClawHub**, telemetry version check, OTLP) · `add-provider`.

**Make it verifiable** — a 44-doc audit done by reading is done once and never again:
- link/anchor check in CI;
- a test asserting the OpenClaw range agrees across `README.md`, `support-matrix.md`, `SECURITY.md`
  and `spec/openclaw-versions.yaml`. That number living in four places with three values is exactly
  how the unbounded `support.max` survived.

---

## 10. Risks

- **§4 is verified; the rest is not.** The spikes refuted two P0s and found four new gaps. Treat
  work-order detail as provisional until its own evidence exists.
- **Inference failed in the same direction twice.** Both refuted gaps came from assuming a documented
  default applied to our topology. Container-detection overrides and dev-only flags are exactly where
  docs and runtime diverge — prefer observation for anything load-bearing.
- **The floor may move again.** It moved once already (2026.8.1 → 2026.9.1) because a plugin's API
  requirement outran the runtime. Plugin/runtime skew (G28) is a standing source of that.
- **Migration is the adoption gate.** If WO-52 is unreliable the 1.x line is where everyone stays. It
  needs the integration-test budget, not a best-effort script.
- **Some users have nothing to migrate.** Given G2, anyone who ran `gateway restart`/`update`/
  `config set` already lost their state. `clawops migrate` must be honest about that rather than
  implying a rescue.
- **Enabling config delivery is itself a breaking change.** Configs that have never been applied will
  apply for the first time. Hence v1.7.2's four guards.
- **Two lines is a standing tax** — two CI matrices, two release paths, a backport judgement per fix.
  The EOL date (2027-03-31) is what keeps that bounded.
- **We will maintain a container image** (WO-53). Deferring to 2.1 keeps it out of this release but
  does not make it go away; decide who owns it first.
- **Provider matrix is unsized** — four adapters × sandboxed/not × migration.
- **Fleet and sandboxing collide** on one host; encode as plan validation.
