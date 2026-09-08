---
"@clawops/cli": major
---

clawops 2.0 — OpenClaw 2.0 support

clawops 2.x targets OpenClaw `>= 2026.9.2`. The 1.x line continues for OpenClaw
`<= 2026.7.1-2` under the `legacy` dist-tag until **2027-03-31**:

```bash
npm install -g @clawops/cli            # 2.x
npm install -g @clawops/cli@legacy     # 1.x maintenance
```

Pin the tag in CI. `latest` moves to 2.x, so an unpinned pipeline will change lines.

---

## Your deployment now keeps its state

OpenClaw 2.0 stores sessions, transcripts and credentials in SQLite under a state
directory. clawops mounted no state at all, so every `gateway restart`, `gateway update`
and `config set` — all of which replace the container — destroyed them.

One host directory (`/var/lib/clawops/openclaw`, or `~/.clawops/openclaw` on macOS) is now
bind-mounted at OpenClaw's own default location, holding the config, the database and any
provider plugins. Existing deployments migrate automatically: provisioning moves an
existing `/home/clawops/openclaw.json` into the new directory and leaves a `.migrated`
marker, only when the destination is absent, so re-running never clobbers a later edit.

The config is mounted as a **writable directory**, not a read-only file. OpenClaw writes
its config by atomic rename, which fails `EBUSY` over a bind-mounted file — that blocked
`openclaw plugins install` outright.

## The gateway is no longer exposed to your network

The container publishes on `127.0.0.1:18789` instead of `0.0.0.0:18789`. Reach it with
`clawops tunnel` or a reverse proxy on the host.

Previously the wizard set `allowedGatewayCidrs` from the CIDR you gave for **SSH**, so a
plaintext HTTP dashboard — token in the URL — was opened to your whole shell-access network
as a side effect of one unrelated answer. The wizard no longer does that.

To bind all interfaces, set `network.publishGateway: "all"`. Exposure is deliberately its
own choice rather than inherited from a firewall rule chosen for something else.
`clawops doctor` reports the scope, `clawops plan` prints it, and restarts preserve it.

**You must act if** a client or reverse proxy on another machine, or external monitoring,
reaches the gateway directly. A proxy on the host is unaffected; one in a *container* on
the host needs `--network host`.

## Containers are hardened

`--cap-drop=ALL`, `--security-opt no-new-privileges`, `--init`, `--pids-limit 512` — the
profile a live `openclaw fleet` cell already runs under. Memory and CPU caps are opt-in:
those divide a host between tenants, and a default would shrink a large single-tenant box
rather than protect it.

## Day-two commands work on AWS

`gateway restart`, `logs`, `monitor`, `backup`, `agents`, `config set` and `doctor`'s
container checks were **all broken on AWS**. clawops connects as `ubuntu`, but provisioning
only put `clawops` in the docker group, so every Docker command failed with `permission
denied`. A second failure hid behind it: the token env file sits in a `750` directory, so
the gateway would have started with no token and exited 78 even with Docker access. Both
are fixed.

## The gateway starts on its own terms now

clawops passed `--allow-unconfigured` on every start. That flag suppresses a check upstream
describes as detecting "suspicious or clobbered config", so clawops could never notice one —
a clobbered config started silently on defaults instead of failing.

Provisioning now writes `gateway.mode: "local"`, which is what the check actually wants, and
the flag is gone. A deployment upgrading from 1.x has its config normalised during migration
using OpenClaw's own `config set`, which also applies OpenClaw's internal config migrations.

## The version pin is enforced everywhere it can change

`clawops gateway update` is the only command whose job is to change the deployed OpenClaw
version, and it was the only one that never checked it — its default was the moving tag
`stable`, passed straight to `docker pull`. It now resolves and range-checks first, and
defaults to a concrete pin. A refused version reaches the host not at all.

## Bad config is caught before it is written

clawops now validates against the schema OpenClaw itself publishes, rather than five
hand-written rules — so a mistake is reported at write time instead of surfacing as a
crash-looping gateway after the restart. A rejected config is kept at
`<path>.rejected.<timestamp>` and your deployment's current config is left untouched.

Two refinements worth knowing. A key the schema does not recognise is only a *warning* when
you are running a newer OpenClaw than clawops captured its schema from — otherwise clawops
would refuse configs your runtime accepts. And `gateway.mode` is required even though
OpenClaw marks it optional: it is optional upstream only because `--allow-unconfigured` can
bypass the check, and clawops no longer passes that flag.

## Removed

**`clawops agents restart`** and the `clawops_agents_restart` MCP tool. OpenClaw 2.0 has no
per-agent restart — only `gateway restart` and `daemon restart`, both of which interrupt
every agent on the host. Aliasing to those would turn a one-agent action into an outage for
agents you weren't touching. Use `clawops gateway restart`, or stay on `@clawops/cli@legacy`.

`clawops agents list` and `clawops agents logs` are unaffected.

## Also

- the gateway no longer self-updates out from under the version you pinned
  (`OPENCLAW_SUPERVISOR_MODE=external`)

- provider plugins that aren't bundled (Bedrock) are installed at provisioning, so a
  locked-down host never reaches for ClawHub at boot
- the OpenClaw 2.0 config schema ships in `spec/`, and clawops validates against it
