# SP-10 — The 2.0 startup contract, measured

**Image:** `ghcr.io/openclaw/openclaw:2026.9.1` · **Date:** 2026-09-06 · **Cost:** $0 (local Docker)

Everything below was observed against the real binary. Where it contradicts an earlier
entry in the migration plan, the plan was written from 2026.8.1 or from release notes.

## 1. `gateway.mode` is a startup gate, and the schema does not express it

| Config | Flag | Result |
|---|---|---|
| no `gateway.mode` | none | **exit 78**, start blocked |
| `gateway.mode: "local"` | none | starts |
| no `gateway.mode` | `--allow-unconfigured` | starts |

```
Gateway start blocked: existing config is missing gateway.mode. Treat this as suspicious
or clobbered config. Re-run `openclaw onboard --mode local` or `openclaw setup`, set
gateway.mode=local manually, or pass --allow-unconfigured.
```

A config with no `mode` passes the captured JSON Schema **and** passes
`openclaw config validate` (`Config valid: /app/config.json`), then exits 78. Schema
validity is not a startup guarantee.

**Consequence (WO-40):** write `gateway.mode: "local"` and drop `--allow-unconfigured`.
clawops passes the flag today and writes no mode, so it permanently depends on an escape
hatch whose stated purpose is bypassing a clobbered-config check.

## 2. The Bedrock provider is not in the image

`plugins list` in a bare container: 61 plugins, 39 enabled, source root
`stock: /app/dist/extensions`. No `bedrock`, no `amazon`, no `aws`. Not on disk either.

It is an **official ClawHub package**, `@openclaw/amazon-bedrock-provider`.

## 3. Configuring it triggers an auto-install, and the first boot fails on purpose

With `models.providers.amazon-bedrock` configured and network egress available:

```
◇  Doctor changes ──────────────────────────────────────────────╮
│  - Installed missing configured plugin "amazon-bedrock" from  │
│    @openclaw/amazon-bedrock-provider.                         │
├───────────────────────────────────────────────────────────────╯
OpenClaw plugin migration inputs changed during startup convergence; refusing to report
the gateway ready. Restart OpenClaw so state migrations run against the final config and
plugin inventory.
```

Exit **1**. Under `--restart unless-stopped` the second boot converges: `restarts=1`, then
stable. So it self-heals — but only if a restart policy is present, and only after a
visible failure that a health check will see.

An earlier 12-second observation showed `running exit=0` and looked like success. The
install had simply not finished. **Do not conclude from a short probe.**

## 4. Without egress it "succeeds" — silently, without the provider

`--network none`, same config: `running exit=0`, no convergence restart, no error. The
gateway is healthy and the configured model provider is absent.

This is the worse outcome, and it is the one a hardened clawops deployment gets:
deny-all egress is the documented default.

## 5. The install does not survive container replacement

The plugin lands at `/app/npm/projects/openclaw-amazon-bedrock-provider-<hash>` — the
container's writable layer, not a mount. Measured across `docker stop && docker rm &&
docker run`, which is exactly what `gateway restart`, `gateway update` and `config set`
do:

| | restarts | re-installed |
|---|---|---|
| first boot | 1 | yes |
| after replacement | 1 | **yes, again** |

So every clawops restart re-fetches the plugin from the network and pays another
convergence restart.

**Consequence:** pre-install provider plugins at provisioning time, or mount the plugin
directory as state (WO-39), or both. Leaving it as-is makes every routine restart depend
on ClawHub being reachable.

## 6. The captured schema earns its place

It rejected a real mistake before startup — a Bedrock model entry with `id` but no
`name` — with `/models/providers/amazon-bedrock/models/0 must have required property
'name'`. The gateway's own answer to the same config was exit 78.
