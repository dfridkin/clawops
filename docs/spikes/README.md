# Spike results

Working notes for the spikes defined in
[`docs/openclaw-2.0-migration-plan.md` §8](../openclaw-2.0-migration-plan.md).

Each spike answers a question the plan is currently guessing at. A spike is finished when its
result is recorded here **and** its assertion has graduated into a test (§5) — a finding that
lives only in a scratch file is a fact we will rediscover.

| Spike | Question | Status |
|---|---|---|
| SP-02 | What does the 2.0 config schema reject? Read-only mount behavior? | in progress |
| SP-03 | Derived image with `docker-ce-cli` | in progress |
| SP-01 | Container profile: P0 confirmation, state-path A/B, uid/gid, loopback impact | blocked on VM |
| SP-06 | Fleet cell profile vs. documented profile | blocked on VM |
| SP-05 | Containerised Fleet CLI | blocked on VM |
| SP-04 | DooD sandboxing end to end | blocked on VM |
| SP-07 | 1.x → 2.0 migration | blocked on VM |
| SP-08 | Bedrock `auth.profiles` via IMDSv2 | done |
| SP-09 | Can the sandbox backend work without a derived image? | done |

## Environment

Recorded per spike, because it matters: uid/gid mapping, AppArmor, and Docker-out-of-Docker all
behave differently on Docker Desktop for macOS than on a Linux host. Spikes marked "local VM" in
the plan are **not** valid on Docker Desktop.

## Results — all 8 complete (2026-09-04)

| Spike | Outcome |
|---|---|
| SP-01 | G1 **refuted**, G2/G3/G5 confirmed, **G3 upgraded** (config read by nothing), **G25 found** (uid 1001 trap); standard state path sufficient; loopback + tunnel verified |
| SP-02 | Seed config schema-**valid** (G4 refuted); channel blocks invalid (**G15 → P0**); 9 dangling `$ref`s (**G26**); `:ro` mount fatal |
| SP-03 | Derived image builds clean, **+70 MB**; `docker` resolves as `node` |
| SP-04 | Sandboxing **feasible**; identity mapping **required** — its absence is silent (empty workspace, no error) |
| SP-05 | Containerised Fleet **works** with `--network host`; no host `npm i -g openclaw` |
| SP-06 | Documented Fleet cell profile **matches reality exactly** |
| SP-07 | Migration works, but **1.x state is inside the container** and there is **no config to carry forward** |
| SP-08 | Bedrock works — **only on ≥2026.9.1**. Floor moved. |
| SP-09 | **No published image needed** — Docker's static CLI mounted into the unmodified official image drives the sandbox backend |
| SP-10 | The 2.0 startup contract, measured | [SP-10](SP-10-openclaw-2.0-startup-contract.md) | `gateway.mode` gate, plugin auto-install + convergence restart, silent absence without egress |

**Two P0s refuted, four new gaps found (G25, G26, plugin-gated providers, plugin/runtime skew),
one version floor moved.**
