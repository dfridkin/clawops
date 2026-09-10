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

## `clawops plan` checks the config it carries

A plan's `spec.openclaw.config` is free-form, so a config the gateway would reject used to
pass plan validation and fail later, on the host, after provisioning. `clawops plan` now
validates it while the plan is still a file you can edit.

Saved plans keep working: `apiVersion` stays `clawops.dev/v1`. A plan pinning a pre-2.0
OpenClaw is refused by the version guard, which names the maintenance line.

## Model providers that need a plugin are installed for you

OpenClaw 2.0 does not bundle every model provider. Of the six clawops offers, **deepseek,
kimi and Amazon Bedrock** are not in the image. A configured-but-missing provider does not
fail loudly: with egress the gateway fetches it mid-boot and restarts once; **without
egress it starts healthy and simply lacks the provider** — and clawops defaults to deny-all
egress, so that was the default outcome.

`clawops apply` now installs them while the deploy still has egress, then checks that every
configured provider actually loaded and warns if one did not. A locked-down host never
reaches for ClawHub at boot.

Plugin versions are **pinned**. These packages track forward independently of the runtime —
all three moved a version within hours during development, and the newer builds required a
runtime newer than the supported floor. Installing "latest" would mean a plan that deployed
this morning fails this afternoon.

## Health checks that can actually fail

The gateway serves its Control UI on a catch-all route, so any unmatched path answers `200`
with HTML. clawops probed with `curl -fsS … >/dev/null`, which **succeeds on a typo** — it
proved something was listening on the port, not that the gateway was healthy.

Probes now read the response body and reject HTML with an explanation. The three probes
that had drifted onto two different paths are one module, and the restart gate uses
`/startupz` rather than a liveness check: after a restart the process listens long before
startup finishes, so the old check could report success while the gateway was still
converging.

`clawops monitor` and `clawops doctor` also reported disk usage for the service user's home
rather than the state directory — which is where the SQLite database now grows, so the
gauge was watching the wrong filesystem.

## Upgrades check your database before replacing anything

`clawops gateway update` used to pull an image and swap the container — and `docker run`
exiting successfully means the container was *created*, not that the gateway started. By
then the previous container is gone.

It now snapshots the state database first, then asks the release you are upgrading **to**
whether it understands that schema, and refuses if it does not. If the snapshot cannot be
taken, the upgrade stops rather than proceeding without a rollback point.

After the swap it waits for the gateway to actually start. If it does not, clawops attempts
one repair, and failing that **rolls back to the image that was running before** — telling
you which state you ended up in rather than leaving you to work it out. If the rollback
will not start either, the message names the snapshot to restore.

## `clawops mcp wire` actually wires something now

It has never worked. It wrote `gateway.mcpClients`, which is **not a key OpenClaw has** —
checked against the config schemas of both `2026.7.1-2` and `2026.9.2`. The real key is
top-level `mcp.servers`. And the entry it wrote was `command: "clawops"` over stdio, which
spawns inside the gateway container, where clawops is not installed.

On 1.x nothing validated the write, so it stored a key nothing read, restarted your gateway,
and told you *"The gateway's AI can now run clawops commands."* It could not.

It now delegates to `openclaw mcp add`, which **probes the server before saving** — so
"wired" means the gateway connected, not that a file was written. A failed probe prints the
reason and changes nothing. Use `--rewire` to replace an existing entry.

If the gateway's OpenClaw has no `mcp add` — `2026.4.5` ships only `list` and `serve` —
clawops says so and names the version to upgrade to. That is asked of the binary rather than
inferred from a version string.

**You have to run the server.** clawops does not run on the gateway host:

```bash
clawops mcp serve --http 18790 --bind 0.0.0.0 --token "$(openssl rand -hex 16)"
clawops mcp wire --stack prod --token <same token>
```

Installing clawops on the gateway host is a follow-up, deliberately not in 2.0 — it puts
deployment credentials on the deployed box, and that needs its own design.

## `clawops mcp serve --http` serves more than one client, and asks who you are

Two bugs, found by testing it against a real gateway rather than a mock.

It built **one transport for the whole process**, so the first client to connect claimed it
and every later one — a second editor, a reconnect, the gateway's own probe — was answered
`"Server already initialized"`. HTTP mode is the multi-client mode. It now creates one
session per client.

It had **no authentication**, while exposing every tool including `clawops_destroy`. It takes
a bearer token now, compares it in constant time, and **refuses to bind anywhere but loopback
without one**:

```
Refusing to serve MCP on 0.0.0.0 without a token. This server exposes every clawops tool,
including destructive ones, and has no other authentication.
```

## The firewall follows the deployment, not a constant

Three security controls were doing the opposite of what they say.

**`clawops harden` opened the gateway port on every deployment.** The `ufw` module ran
`ufw allow 18789/tcp` unconditionally. Since the gateway publishes on `127.0.0.1`, that
opened a port nothing was listening on — a hardening step widening the firewall past what
the deployment exposes. It now reads the running container's port bindings and adds the rule
only when the gateway is actually published, on whatever port it is published on.

**The AWS security-group audit exempted the two ports it exists to check.** Ports 22 and
18789 were on an "expected" list, so a group opening SSH *or the gateway* to `0.0.0.0/0` was
reported as "No unexpected open ingress rules found". It also never looked at IPv6 rules, so
`::/0` was invisible. A wide rule on any port is a finding now.

**The setup wizard defaulted SSH access to `0.0.0.0/0`.** Pressing Enter opened SSH to the
whole internet on the path most first-time users take. It now offers your own IP as a `/32`,
and when that cannot be detected it offers no default and requires an answer.

Cloud stacks no longer get gateway ingress rules while the gateway publishes on loopback:
they grant no access and read to an auditor as an exposed gateway. `clawops plan` refuses
that combination rather than creating rules that do nothing.

## The gateway port comes from the plan

`spec.network.gatewayPort` carries it into the security-group rules, the container publish
flag, the default `gateway.port` and the gateway URL. It was a constant redeclared in eleven
places, so changing it meant finding all of them — and missing one produced a container
publishing one port, a gateway listening on another, and a firewall opening a third.

```jsonc
"network": {
  "allowedSshCidrs": ["203.0.113.4/32"],
  "allowedGatewayCidrs": [],
  "publishGateway": "loopback",
  "gatewayPort": 9443
}
```

Local deployments use `clawops up --gateway-port 9443`, which refuses a value that is not a
port rather than falling back to the default and publishing somewhere you did not ask for.

## `clawops doctor` asks the gateway, and its exit code means something

`doctor` read `docker inspect`'s healthcheck field, which the OpenClaw image does not set —
so it reported "no healthcheck configured" and moved on. A running container means the
process started, not that it serves. It now probes `/startupz` and reads the body.

It exits **1 when any check failed**. Only an old Node.js used to do that, so a CI step
running `clawops doctor` read an unreadable SSH key or an unsupported gateway as success.
Warnings still exit 0 — an unconfigured machine is not a broken one. `--json` emits the
whole report.

## `clawops_doctor` — diagnostics as an MCP tool

The checks moved out of the command into `src/diagnostics`, because a stdio MCP server
cannot write to stdout (R15) and `doctor` printed as it went. An agent that hits a failure
can now find out why, with `failuresOnly` to skip what passed. It reports only — it never
runs `openclaw doctor --fix`.

## `clawops agents list` stops inventing an empty list

The command ended in `|| echo '[]'`, so a stopped container, a gateway still starting, or a
Docker permission error all produced "No agents running." — a wrong answer rather than an
error. Both the CLI and the MCP tool now fail and say which.

## MCP config tools read the config the way everything else does

`clawops_config_{get,set,unset,validate}` each hand-rolled `cat` on a hardcoded Linux path
with an unprivileged exec — wrong on a macOS target, and dependent on the SSH user happening
to be uid 1000 on Linux. They go through the shared reader, which detects the OS and
escalates. This is the same defect as the gateway-restart one fixed in 1.7.6: a handler
re-implementing what a shared module owns, and so missing its fixes.

## The tool catalog is checked, not just declared

`spec/mcp-tools.yaml` was cast to a type and generated from. A tool missing `readOnlyHint`
generated `readOnlyHint: undefined`, which compiles and ships, leaving the client on its
defaults — R10 defeated with nothing to see. Generation now fails on a missing or
non-boolean hint, a name that breaks the convention, an unknown toolset, a read-only tool
outside the `read` toolset (or a writing one inside it), and the R1/R2 caps.

Tests assert the registry and the catalog list the same tools, and that the README and the
risk matrix tables match both. They did not: the README listed `clawops_ssh_exec` and
`clawops_agents_restart`, neither of which exists, and omitted five that do; the risk matrix
claimed 15 tools above sixteen rows and marked three unavailable in `--read-only` that the
catalog puts in the `read` toolset.

## `clawops migrate` moves an existing 1.x deployment across

```bash
clawops migrate --stack prod
```

It takes a verified backup inside the running container, extracts the state **from that
running container** — stopping first would destroy it, since 1.x kept everything inside —
owns it numerically, starts 2.0 against it, and waits for the gateway to actually come up.

Your old config is **not** applied. It never applied on 1.x either: the file clawops mounted
was read by nothing. It is reported as something to review, and a fresh valid 2.0 config is
written instead.

Device identity is preserved, so paired devices do not need re-pairing — `migrate` compares
it before and after and tells you if that ever stops being true.

**If you ran `gateway restart`, `gateway update` or `config set` on a clawops before 2.0,
your state is already gone.** Nothing was mounted to survive the container replacement.
`migrate` says so plainly rather than pretending to rescue it.

## `clawops backup restore` works again

It was made to fail in v1.7.5, because the OpenClaw it supported had no restore subcommand
to call. 2.0 has one, and clawops delegates to it: the archive is uploaded, verified, and
expanded into a **fresh staging directory**. Nothing is activated for you, and restoring in
place is not offered — writing an archive over a live state directory is how a backup
becomes corruption.

OpenClaw's own warnings are printed verbatim, including one that matters here: plugin
`node_modules` are not archived, so re-run `clawops apply` after adopting a restore or the
gateway starts without its model providers.

**The archive is a credential.** It carries the state database — OAuth stores, secret store
entries, device tokens — unencrypted. clawops now writes it `0600` locally; it previously
used the default `0644`.

## Chat channels need their plugin installed, and the catalog said otherwise

Every channel in OpenClaw 2.0 is an install-gated plugin — all 31 of them. Configuring one
without installing it gives you a gateway that starts, reports healthy, and never connects.

The wizard's catalog had been wrong in three ways since before 2.0, none of it visible without
a deployed gateway:

| | It said | OpenClaw wants |
|---|---|---|
| Microsoft Teams | `teams` | `msteams` |
| Discord | `botToken` | `token` |
| WhatsApp | `phoneNumberId`, `accessToken` | neither exists — credentials live per account |

`dmPolicy` and `groupPolicy` are required on every channel, Slack requires four more, and
WhatsApp one. The catalog records them, and a test validates the whole thing against
OpenClaw's own schema so it cannot drift again.

**Every environment variable the catalog named was wrong.** It used `OPENCLAW_DISCORD_TOKEN`
and friends; OpenClaw reads `DISCORD_BOT_TOKEN`, `TELEGRAM_BOT_TOKEN`, `SLACK_BOT_TOKEN`. The
wizard was storing secrets under names nothing looked at.

The wizard no longer offers WhatsApp, whose credentials it cannot collect, and it tells you
the command to install a channel's plugin instead of leaving you with config that connects to
nothing. Telegram turns out to ship **in the image** — it activates with no download and no
egress. WhatsApp and Microsoft Teams have **no non-interactive setup in OpenClaw at all**
(`channels add` rejects `--use-env` for them), so the wizard says to configure them on the
host rather than pretending.

**Channel plugins install from npm, not ClawHub** — `@openclaw/<channel>`. Model providers
come from ClawHub. Allowing one host does not allow the other; both are in
[required outbound access](docs/security/egress.md).

## Docs

`docs/security/egress.md` is new: every outbound destination clawops needs, from which
machine, when, and what it looks like when one is blocked. ClawHub is the new one in 2.0.

The pre-2.0 contract had outlived itself in the docs — the old config path, a `docker run`
line mounting a config file read-only, `backup restore` described as unavailable, and
`:stable` image tags the version guard now refuses. All corrected.

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
