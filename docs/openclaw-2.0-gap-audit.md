# WO-58 — Systematic gap audit

Every file in `src/` that references `openclaw` (30 of them), read against the 2.0 runtime
contract as **measured** in [SP-10](spikes/SP-10-openclaw-2.0-startup-contract.md), not as
described in release notes.

Phase 1 was not scoped until this landed. Two items below change its shape.

## Method

The earlier sweeps followed the trail of a reported failure and missed sibling instances
twice — G32 (the MCP restart path) survived a fix that claimed to cover "all three restart
paths", because the fix followed the three the bug report named. This audit enumerates the
surface first, then checks every element against each contract dimension.

## Findings by severity

### 1. No state persistence anywhere — G2, confirmed total

**Not one of the 30 files mounts a state volume or sets `OPENCLAW_STATE_DIR`.**

In 2.0 sessions, transcripts and credentials live in SQLite under the state directory.
Every container replacement destroys all of it — and container replacement is not an edge
case, it is what `gateway restart`, `gateway update` and `config set` all do.

This is the largest single item in Phase 1, and it is not partially done. It is absent.

### 2. The config is mounted as a read-only *file*, in all four places

| File | Line |
|---|---|
| `openclaw/run-flags.ts` | 124 — the shared builder, so every restart path |
| `providers/startup.ts` | 101 — cloud provisioning |
| `providers/local/bootstrap.sh.tmpl` | 175, 199 — local provisioning, both paths |

SP-10b §4: OpenClaw writes config by atomic rename, and renaming over a bind-mounted file
fails `EBUSY` whether the mount is `:ro` or `rw`. On 2.0 this blocks `plugins install`
outright and any config write the gateway makes.

**This is new scope for WO-38.** The original work order said "one runtime contract, one
builder"; it must also change the config from a file mount to a directory mount. Every one
of these four sites changes shape, not just value.

### 3. `--allow-unconfigured` at all three run sites, and `gateway.mode` written nowhere

`run-flags.ts`, `startup.ts`, `bootstrap.sh.tmpl` all pass the flag. No file writes
`gateway.mode`. Measured: with the mode present the gateway starts without the flag; the
flag exists to bypass a check upstream describes as detecting "suspicious or clobbered
config". clawops depends on that hatch permanently today. WO-40.

### 4. Port `18789` hardcoded in 9 files

`providers/aws/program.ts`, `providers/azure/program.ts`, `providers/gcp/program.ts`,
`providers/local/bootstrap.ts`, `providers/local/bootstrap.sh.tmpl`, `providers/startup.ts`,
`openclaw/run-flags.ts`, `cli/commands/monitor.ts`, `pulumi/components/gateway.ts`.

WO-42 / WO-48. Unchanged by 2.0, but it is the reason a port change is a 9-file edit.

### 5. Config path `/home/clawops/openclaw.json` hardcoded in 4 files

`cli/commands/config.ts`, `cli/commands/gateway.ts`, `cli/commands/monitor.ts`,
`plan/remote-config.ts`.

All four change under WO-39, because the path becomes a **directory**. `monitor.ts` also
reads the file directly rather than going through the gateway.

### 6. `journalctl -u openclaw` in 3 files

`cli/commands/logs.ts`, `mcp/tools/cli/logs.ts`, `cli/commands/setup.ts`.

Only the local provider ever creates a systemd unit. Cloud VMs work by accident: the
command fails and falls through to `|| docker logs openclaw`. It produces the right output
for the wrong reason, and the fallback hides which one ran. Make it explicit under WO-38.

### 7. `pulumi/components/gateway.ts` — dead code that looks alive

Wrong registry (`ghcr.io/anthropics/openclaw`, **G7**), no gateway command, no config
mount, no port pin. Nothing constructs it except its own test, so no user is exposed. It
is a trap for whoever wires it up next. Delete it or rebuild it on the shared builder under
WO-38 — but do not leave it.

### 8. Two of the three `agents` subcommands clawops uses were **removed in 2.0**

Verified against `2026.9.2`:

| clawops invokes | 2.0 | Replacement |
|---|---|---|
| `agents list --json` | ✅ exists (`--json`, `--bindings`, `--tree`) | — |
| `agents restart [name]` | ❌ *"OpenClaw does not know the command"* | `gateway restart` — **gateway-wide, not per-agent** |
| `agents logs <name> --follow` | ❌ *"OpenClaw does not know the command"* | `logs --follow` — **gateway-wide, not per-agent** |

2.0's `agents` surface is `add`, `bind`, `bindings`, `delete`, `list`, `set-identity`,
`unbind`. Per-agent restart and per-agent log tailing are gone as concepts, not merely
renamed.

This breaks two shipped commands and one MCP tool:

- `cli/commands/agents.ts` — `clawops agents restart`, `clawops agents logs`
- `mcp/tools/cli/agents.ts` — `clawops_agents_restart` (and its `spec/mcp-tools.yaml` entry)

**This needs a product decision, not just a port.** Either these narrow to gateway-wide
operations — in which case `clawops agents restart` is a misleading name for
`gateway restart` and should probably be removed rather than silently widened — or they
are dropped. Silently turning a per-agent restart into a whole-gateway restart is the
worst option: it is a surprise with an outage in it.

### 9. 2.0 replaces three of clawops's shell workarounds with real commands

Not gaps, but they change what WO-38 should build:

| clawops does today | 2.0 offers |
|---|---|
| `journalctl -u openclaw \|\| docker logs openclaw` | `openclaw logs --follow --json --limit` — over RPC, structured |
| `curl /healthz` polling | `openclaw health`, `gateway health`, `gateway probe` |
| `docker inspect` for gateway state | `gateway probe` (reachability, auth capability, read-probe) |

Building on these instead of shelling around the container is strictly better, and removes
the systemd assumption in §6 rather than making it explicit.

Also worth noting for later work orders: 2.0 ships `migrate *` ("Import state from another
agent system"), directly relevant to **WO-52**; `database *` ("Inspect shared-state schema
compatibility and write ownership"), relevant to **WO-39**; and `fleet *` ("Provision and
manage isolated tenant cells", experimental), which is the Fleet question from §7.4 now
answered upstream.

## Not affected

The version-guard machinery (`openclaw/versions.ts`, `cli/version-guard.ts`, `spec-path.ts`)
is contract-agnostic and already 2.0-ready. The plan/apply flow (`plan/generate.ts`,
`plan/apply.ts`, `cli/commands/plan.ts`, `up.ts`, `mcp/tools/cli/up.ts`) carries the
OpenClaw version as data and does not encode runtime shape. `config/secrets.ts` mentions
openclaw only in a comment.

`cli/commands/doctor.ts` uses `docker inspect ... || echo 'not found'` — a **reporting**
fallback, not a deploy fallback, so it is not the defect class fixed in v1.7.6. Doctor is
where the SP-10b provider reconcile (`plugins list --json`, compare `providerIds` against
`models.providers` keys) should live.

## What this changes about Phase 1

1. **WO-38 grows.** It is not only consolidation — it must convert the config mount from a
   file to a directory across four sites, which is a shape change to the run command.
2. **WO-39 does not shrink.** State persistence is absent rather than partial, so there is
   no existing behaviour to preserve or migrate around.
3. **Two shipped commands and one MCP tool break outright.** `clawops agents restart` and
   `clawops agents logs` call subcommands 2.0 removed. That is a product decision (narrow to
   gateway-wide, or drop) rather than a port, and it should be made before WO-38 is estimated.
4. **WO-38 should build on 2.0's own CLI**, not around it — `logs`, `health` and
   `gateway probe` replace the journalctl/curl/docker-inspect workarounds.
