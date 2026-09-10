# @clawops/cli

## 2.0.0

### Major Changes

- 8adf96c: clawops 2.0 — OpenClaw 2.0 support

  clawops 2.x targets OpenClaw `>= 2026.9.2`. The 1.x line continues for OpenClaw
  `<= 2026.7.1-2` under the `legacy` dist-tag until **2027-03-31**:

  ```bash
  npm install -g @clawops/cli            # 2.x
  npm install -g @clawops/cli@legacy     # 1.x maintenance
  ```

  Pin the tag in CI. `latest` moves to 2.x, so an unpinned pipeline will change lines.

  ***

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
  reaches the gateway directly. A proxy on the host is unaffected; one in a _container_ on
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

  Two refinements worth knowing. A key the schema does not recognise is only a _warning_ when
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
  exiting successfully means the container was _created_, not that the gateway started. By
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
  and told you _"The gateway's AI can now run clawops commands."_ It could not.

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
  18789 were on an "expected" list, so a group opening SSH _or the gateway_ to `0.0.0.0/0` was
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

  |                 | It said                        | OpenClaw wants                                |
  | --------------- | ------------------------------ | --------------------------------------------- |
  | Microsoft Teams | `teams`                        | `msteams`                                     |
  | Discord         | `botToken`                     | `token`                                       |
  | WhatsApp        | `phoneNumberId`, `accessToken` | neither exists — credentials live per account |

  **And the config the wizard wrote was never valid.** `dmPolicy` and `groupPolicy` are required
  on every channel, Slack requires four more, WhatsApp one — and a JSON Schema _default_ does not
  satisfy _required_, so every channel block the wizard produced was rejected before it reached a
  host. The wizard writes those values now, and a test validates its actual output against
  OpenClaw's schema so it cannot drift again.

  **Slack is set up for Socket Mode**, which is OpenClaw's default and what its own tooling
  installs: the gateway dials out to Slack, so there is no public webhook to register. It needs
  an app-level token (`xapp-`) rather than a signing secret, and the catalog previously described
  the webhook setup instead — while declaring the socket credentials incompletely.

  **Every environment variable the catalog named was wrong.** It used `OPENCLAW_DISCORD_TOKEN`
  and friends; OpenClaw reads `DISCORD_BOT_TOKEN`, `TELEGRAM_BOT_TOKEN`, `SLACK_BOT_TOKEN`. The
  wizard was storing secrets under names nothing looked at.

  **`clawops apply` installs channel plugins for you**, alongside model providers, before the
  restart while the deploy still has egress — then checks the gateway to confirm they are
  actually installed rather than trusting an exit code. It has reason not to: `openclaw channels
add` returns **0** when the plugin install fails, so clawops installs with `openclaw plugins
install`, which exits 1.

  Channel plugins are pinned to the supported runtime, and that pin matters — the current
  `latest` refuses to install:

  ```
  plugin "discord" requires plugin API >=2026.9.3, but this OpenClaw runtime exposes 2026.9.2
  ```

  The wizard no longer offers WhatsApp, whose credentials it cannot collect. Telegram turns out to ship **in the image** — it activates with no download and no
  egress. WhatsApp and Microsoft Teams have **no non-interactive setup in OpenClaw at all**
  (`channels add` rejects `--use-env` for them), so the wizard says to configure them on the
  host rather than pretending.

  **Channel plugins install from npm, not ClawHub** — `@openclaw/<channel>`. Model providers
  come from ClawHub. Allowing one host does not allow the other; both are in
  [required outbound access](docs/security/egress.md).

  ## Logs come from the gateway, and clawops says which source answered

  Both `clawops logs` and the MCP tool ran `journalctl -u openclaw || docker logs openclaw`.
  Only the local provider creates that systemd unit, so on every cloud VM the first command
  failed and the fallback answered — the right output for the wrong reason, with nothing saying
  which had run. The two sources carry different things.

  Logs now come from OpenClaw 2.0's own `openclaw logs`, which reads the gateway's structured
  log file and can emit JSON. It works over RPC, so a gateway that is down cannot serve its own
  logs — which is exactly when you want them. clawops probes first, falls back to container
  output, and **names the source either way**.

  `--since` is a container-log filter and the gateway command has no time window, so asking for
  one selects the container source. That is reported rather than silently ignored.

  ## `clawops agents logs` reads the audit log

  OpenClaw 2.0 removed `agents logs`, so the command clawops was running did not exist — it
  would have failed on every 2.0 gateway. Agent-scoped records live in the audit log now:

  ```bash
  clawops agents logs slack-bot --limit 100 --json
  clawops agents logs slack-bot --cursor <cursor>
  ```

  It is a paged query rather than a stream, so there is no `--follow`: it returns a cursor to
  continue from. `clawops logs` stays gateway-wide, because its envelope carries no agent key to
  filter on.

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

## 1.7.7

### Patch Changes

- 4368bcd: Prepare the two release lines: 1.x maintenance, 2.x current

  clawops 2.x and 1.x target incompatible OpenClaw runtimes, so the project ships two lines
  rather than one that deploys either badly. This wires the release path for both.

  `scripts/ci-publish.sh` takes an optional dist-tag, and the 1.x branch passes `v1`.
  Without it `changeset publish` defaults to `latest`, so the first 1.x patch released after
  2.0.0 would take `latest` back and start serving 1.x to everyone running a fresh install.

  The release workflow now runs on both branches from one file, so it does not have to be
  fixed twice. MCP registry publishing stays on `main` only: the registry serves one current
  version per server, and a 1.x patch would drag the entry backwards for every client that
  discovers clawops through it.

  The support policy is now written down — dist-tags, the OpenClaw range each line accepts,
  what gets backported, and a fixed end-of-life date of 2027-03-31 for 1.x, recorded as a
  date rather than a duration so it cannot quietly move.

## 1.7.6

### Patch Changes

- a1e145c: Fix the MCP gateway restart, and stop restarts falling back to an unsupported version

  **`clawops_gateway_restart` broke deployments in the way v1.7.5 fixed everywhere else.**
  The MCP tool hand-wrote its own `docker run` and so was missed by that consolidation: it
  started the container with no gateway command, losing `--allow-unconfigured`, the port pin
  and the auth token. An agent calling this tool left a crash-looping gateway. It now uses the
  same builder as the CLI, which the test suite enforces rather than assumes.

  **Restarts no longer fall back to `latest` or `stable`.** All three restart paths reused the
  image the host was already running — correct — but fell back to a moving tag when
  `docker inspect` found no container. Both tags now resolve to OpenClaw 2.0, which this
  release line refuses to deploy, so the fallback pushed an unsupported version past the very
  guard added in v1.7.2 to stop it. With no container there is nothing to reuse, so clawops
  now says so and points at `clawops up --openclaw-version <version>`.

## 1.7.5

### Patch Changes

- 39ab3f3: Fix gateway restart, and remove calls to a binary that does not exist

  **`gateway restart`, `gateway update` and `config set` broke a working deployment.**
  Each rebuilt the `docker run` string by hand and passed no gateway command at all, so
  the container fell back to the image's bare `CMD` — losing `--allow-unconfigured`,
  the port pin and the auth token, and dying with `Gateway start blocked: existing
config is missing gateway.mode`. Verified against OpenClaw 2026.7.1: a deployment
  healthy after `clawops up` reached 30 restarts after one `gateway restart`.

  v1.7.2 made this worse rather than causing it. Moving the token into an env file
  fixed first boot and left the restart paths reading it from a config field that is
  now always empty.

  All three paths now build their command in one place, so they cannot drift again.
  The token env file is attached through a shell test, so a deployment created before
  v1.7.2 — which has no env file — still starts.

  **`openclaw-ctl` is not a binary in the OpenClaw image.** `command -v openclaw-ctl`
  returns nothing; the binary is `/usr/local/bin/openclaw`. `clawops backup create`,
  `backup restore` and both MCP `agents` tools invoked it, so none of them ever ran.

  - `backup create` now calls `openclaw backup create --output <path>` and streams the
    archive out. There is no stdout mode, which is what the previous `--stdout` flag
    assumed.
  - `backup restore` now fails with an explanation. OpenClaw 2026.7.1 ships `backup
create` and `backup verify` only — restore arrived in 2.0. Hand-rolling an untar
    into a live state directory is how backups become corruption.
  - MCP `agents list` / `agents restart` call the real binary.

## 1.7.4

### Patch Changes

- 19b4785: `clawops --version` reported the wrong version

  The CLI reported a hardcoded `0.2.0` in `--version` and `--help` — five releases
  stale — while `clawops bug` reported the real version from the build-time define.
  Two version sources that disagreed, which is why the drift went unnoticed: bug
  reports carried the correct version while the CLI told users something else.

  Both now read the same define, with a test so a literal cannot creep back in.

## 1.7.3

### Patch Changes

- 99563fb: README release notes refreshed

  The "What's new" section had accumulated four versions and was missing v1.7.2 entirely. It now
  carries the current line only, with `CHANGELOG.md` as the full history.

  Also corrects the stated test count in the README development section and the SPEC status line —
  both were several hundred behind (493 and 688 respectively, against 786 actual).

## 1.7.2

### Patch Changes

- cdbea67: Refuse OpenClaw 2.0, and fix config delivery

  **Version ceiling.** `spec/openclaw-versions.yaml` declared no upper bound and, more
  importantly, was read by no code — so clawops accepted any OpenClaw release, including
  2.0. Deploying 2.0 from this line produces a crash-looping gateway (exit 78) and, with
  no state volume mounted, destroys sessions and credentials on every restart. `doctor`,
  `plan`, `up` and `apply` now refuse anything above 2026.7.1-2 and point at clawops 2.x.

  **Moving tags are resolved before the range check**, and an unresolved tag is refused
  rather than assumed safe. The default OpenClaw version is now a concrete pin instead of
  `stable`/`latest` — both of which now resolve to 2.0.

  **`doctor` reports the deployed version**, because refusing future operations does
  nothing for someone who already deployed 2.0 with a moving tag.

  **Config delivery.** `clawops config set` has never applied: the mounted config was read
  by nothing on either OpenClaw line. Setting `OPENCLAW_CONFIG_PATH` fixes it, guarded by
  port normalisation, an argv `--port` pin, and a parse check. The MCP `gateway restart`
  tool, which dropped the config mount entirely, now mirrors the CLI path.

  **Ollama** now defaults to `host.docker.internal` and clawops passes
  `--add-host=host.docker.internal:host-gateway`, so a host-side Ollama is reachable from
  the container for the first time.

  **Gateway auth token.** A fresh local bootstrap could not start a gateway at all: OpenClaw
  refuses a non-loopback bind without auth, and the bootstrap never supplied a token, so the
  container exited 78 and systemd restart-looped. A token is now generated once and passed
  via a 0600 env file — never on argv.

  **Packaging.** `spec/` was missing from the published files and both it and
  `bootstrap.sh.tmpl` were unresolvable from the bundle, so `clawops plan` and `clawops up`
  (local) failed from an installed package. All three are now shipped and resolved correctly.

  **SSH host-key verification.** The verifier read `parts[1]` of each `known_hosts` line as
  the key, but in OpenSSH format that field is the key _type_ — so any standard entry failed
  permanently with `Host denied (verification failed)`. It only worked against clawops's own
  two-field hex format, and would have corrupted `~/.ssh/known_hosts` if pointed at one.
  Standard entries now parse, including comma-separated host lists, `[host]:port`, hashed
  hostnames, `@revoked` / `@cert-authority` markers, and wildcard and negated patterns.
  Legacy hex entries are still accepted; new entries are written in standard format.

  ⚠️ **Behaviour change:** a host covered by a wildcard whose key does not match is now
  refused where it previously connected. Ignoring wildcards meant trust-on-first-use
  accepted a key the operator's own file contradicted; matching them turns that into the
  refusal it should be. This matches OpenSSH, and was cross-checked against `ssh` directly.

## 1.7.1

### Patch Changes

- 13a47e9: docs(readme): bring "What's new" changelog current through v1.7.0

  The README changelog stopped at v1.5.0 while two releases had shipped since.
  Added the missing sections: v1.6.0 (`clawops bug` command + the 10-bug cloud
  deploy audit fixes) and v1.7.0 (`clawops harden` command, its default/opt-in
  and AWS module sets, plus the `setup` and `doctor` integrations).

## 1.7.0

### Minor Changes

- 4d4d507: Add `clawops harden` command — server hardening MVP (WO-29, WO-30, WO-33)

  **New command: `clawops harden`**

  `clawops harden [--stack <name>] [--options ssh,ufw,...] [--dry-run] [--list]`

  Runs an idempotent set of hardening modules against a deployed stack over SSH. Each module has a `check()` (read-only) and `apply()` (makes the change) step. `check()` runs first; if already satisfied, `apply()` is skipped. Sentinel files at `/etc/clawops/hardening/<module>.applied` detect previous runs without re-reading full system config.

  **Common modules (all providers) — ON by default:**

  - `ssh` — hardens `sshd_config`: `PermitRootLogin no`, `PasswordAuthentication no`, `MaxAuthTries 3`, `LoginGraceTime 30`. Guards against lockout by verifying `authorized_keys` is non-empty before restarting sshd.
  - `ufw` — sets UFW to deny-all incoming, allows SSH + gateway (18789) ports, enables.
  - `fail2ban` — installs fail2ban with SSH jail: 5 failures → 10-minute ban.
  - `unattended-upgrades` — enables security-only automatic updates.
  - `docker-socket` — verifies `/var/run/docker.sock` is `root:docker 660`.

  **Common modules — opt-in:**

  - `auditd` — kernel audit logging for privileged commands.
  - `lynis` — CIS Level 1 benchmark scan; saves full report to `~/.clawops/reports/`.
  - `sysctl` — hardens kernel settings: `ip_forward=0`, TCP SYN cookies, no ICMP redirects.

  **AWS modules (WO-30) — ON by default (check-only):**

  - `aws-sg-audit` — warns if any Security Group ingress rule allows `0.0.0.0/0` on unexpected ports.
  - `aws-ssm-check` — verifies the instance IAM role has `AmazonSSMManagedInstanceCore` for emergency SSM shell access.

  **AWS modules — opt-in:**

  - `aws-flow-logs` — enables VPC Flow Logs → CloudWatch (billed per GB).
  - `aws-guardduty` — enables GuardDuty threat detection (~$4/mo per account).

  **Setup wizard integration**

  `clawops setup` now presents a multi-select hardening step after deploy (pre-checked: ssh, ufw, fail2ban, unattended-upgrades, docker-socket). Skippable with `--no-harden`.

  **Doctor integration**

  `clawops doctor --stack <name>` now includes a Hardening section showing which modules are applied, missing, or drifted.

  **New dependencies:** `@aws-sdk/client-ec2`, `@aws-sdk/client-iam`, `@aws-sdk/client-guardduty`, `@aws-sdk/client-cloudwatch-logs` (AWS hardening modules only; tree-shaken in the bundle for non-AWS deployments).

## 1.6.0

### Minor Changes

- 428a1b3: Add `clawops bug` command and fix 10 cloud deploy bugs found in audit

  **New command: `clawops bug`**

  `clawops bug` opens a pre-filled GitHub issue with system context (version, Node, OS, provider, stack count, SSH key presence) automatically populated. `--json` mode emits the URL without prompting or opening a browser, suitable for scripting.

  `clawops doctor` now prints a `clawops bug` hint in its footer when it exits with an error.

  **Cloud deploy bug fixes (AWS, GCP, Azure)**

  - **Azure (deploy-blocking):** Fixed deprecated image reference `UbuntuServer/22.04-LTS` → `0001-com-ubuntu-server-jammy/22_04-lts-gen2`. Azure no longer publishes the old offer in most regions; every Azure deployment was broken.
  - **AWS (silent failure):** Fixed Bedrock startup script using a plain `curl` to IMDS that always returned HTTP 401 because the EC2 instance requires IMDSv2 (`httpTokens: required`). The region env var always fell back to `us-east-1` regardless of actual region. Now uses the two-step PUT→GET token flow.
  - **Azure (feature-broken):** Fixed `roleDefinitionId` in Key Vault role assignment missing the `/subscriptions/{id}/` prefix — the ARM API rejected the short form. Key Vault RBAC (`keyVaultEnabled=true`) was entirely non-functional.
  - **All providers (silent lockout):** `accessMode=auto` egress IP detection now returns a `Result` type. If detection fails (network error, timeout, non-200 response), the program throws a clear error instead of silently producing a VM with zero ingress rules and no way to connect.
  - **AWS (day-2 ops, ⚠️ migration impact):** Migrated from inline `SecurityGroup` ingress/egress arrays to individual `SecurityGroupIngressRule`/`SecurityGroupEgressRule` resources. This prevents Pulumi from replacing the entire Security Group (and causing a connectivity outage) when CIDRs change. **Existing AWS stacks will have their Security Group replaced on the first `clawops up` after this upgrade** — see `docs/decisions/0009-aws-sg-rule-resources.md` for the import-based mitigation path.
  - **AWS (security):** Replaced `AmazonBedrockFullAccess` with a least-privilege inline policy granting only `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream`.
  - **All providers (correctness):** Extracted shared `src/providers/startup.ts`. Fixes: missing `chown clawops:clawops /home/clawops/.ssh` in GCP script, missing `docker-buildx-plugin` and `docker-compose-plugin` in all three providers, GPG key download updated to direct `.asc` method (no `gpg --dearmor` pipe).
  - **GCP:** Switched `detectEgressIp` from `checkip.amazonaws.com` (AWS-operated) to `ifconfig.me` (provider-neutral).
  - **GCP:** Added missing `?? ''` / `?? 22` / `?? 'clawops'` fallbacks to `getConnectionInfo` (parity with AWS/Azure adapters).
  - **SSH:** `tunnel()` server error handler now calls `closeAll()` before rejecting, preventing accepted sockets from leaking.

  **v1.6 internal work**

  - `src/config/profiles.ts` — credential resolution from `credentialsRef` (was a stub)
  - `src/config/secrets.ts` — `$secret:<NAME>` reference resolver for config overlays (was a stub)
  - `src/pulumi/components/` — proper `ComponentResource` classes for Gateway, Network, Secrets, Server (were stubs)
  - Local VM e2e test harness (`tests/e2e/local/`) using testcontainers + real SSH

## 1.5.0

### Minor Changes

- fb0ed21: feat(monitor): Wave 10 — clawops monitor interactive dashboard + clawops_monitor MCP tool (WO-26, WO-27)
- fb0ed21: Wave 11 (WO-28): gateway-agent MCP client wiring.

  Adds `clawops mcp wire [--stack <name>] [--force]` — a standalone command that writes an MCP client entry into the deployed gateway's `openclaw.json` so the gateway's own AI agent can call clawops directly. Version-gated (requires OpenClaw ≥ 2026.4; bypass with `--force`). Re-run detection shows a targeted re-wire message when the entry already existed.

  Also adds an optional wizard step at the end of `clawops setup`: after a successful local or cloud deploy, the wizard prompts "Should the OpenClaw gateway's AI also be able to manage this stack?" (default: no). Accepting wires the client automatically over the same SSH session.

- fb0ed21: feat(secret): secret lifecycle CLI — list, set, delete, rotate, audit (WO-25)

  - `clawops secret list` — show all secrets in ~/.clawops/secrets/ with status and last-modified
  - `clawops secret set <name>` — create or update a secret interactively (hidden input, chmod 600)
  - `clawops secret delete <name>` — remove a secret with cross-stack ref warning
  - `clawops secret rotate <name>` — update secret + re-apply config overlay + gateway restart
  - `clawops secret audit` — report empty/missing secret files and unresolvable $secret: refs
  - `src/plan/overlay-store.ts` — persist config overlay + secrets refs per stack so rotate can re-apply without re-running the wizard
  - `clawops setup` and `clawops apply` now save the overlay after each successful apply
  - `docs/secrets.md` — full secret lifecycle reference: sources, rotation procedures, security notes

## 1.4.0

### Minor Changes

- f597652: feat(monitor): Wave 10 — clawops monitor interactive dashboard + clawops_monitor MCP tool (WO-26, WO-27)
- f597652: feat(secret): secret lifecycle CLI — list, set, delete, rotate, audit (WO-25)

  - `clawops secret list` — show all secrets in ~/.clawops/secrets/ with status and last-modified
  - `clawops secret set <name>` — create or update a secret interactively (hidden input, chmod 600)
  - `clawops secret delete <name>` — remove a secret with cross-stack ref warning
  - `clawops secret rotate <name>` — update secret + re-apply config overlay + gateway restart
  - `clawops secret audit` — report empty/missing secret files and unresolvable $secret: refs
  - `src/plan/overlay-store.ts` — persist config overlay + secrets refs per stack so rotate can re-apply without re-running the wizard
  - `clawops setup` and `clawops apply` now save the overlay after each successful apply
  - `docs/secrets.md` — full secret lifecycle reference: sources, rotation procedures, security notes

## 1.3.0

### Minor Changes

- 1a20f1f: feat(secret): secret lifecycle CLI — list, set, delete, rotate, audit (WO-25)

  - `clawops secret list` — show all secrets in ~/.clawops/secrets/ with status and last-modified
  - `clawops secret set <name>` — create or update a secret interactively (hidden input, chmod 600)
  - `clawops secret delete <name>` — remove a secret with cross-stack ref warning
  - `clawops secret rotate <name>` — update secret + re-apply config overlay + gateway restart
  - `clawops secret audit` — report empty/missing secret files and unresolvable $secret: refs
  - `src/plan/overlay-store.ts` — persist config overlay + secrets refs per stack so rotate can re-apply without re-running the wizard
  - `clawops setup` and `clawops apply` now save the overlay after each successful apply
  - `docs/secrets.md` — full secret lifecycle reference: sources, rotation procedures, security notes

## 1.2.1

### Patch Changes

- 9536db0: docs: Wave 8 — demo script, GitHub issue templates, README wizard quickstart (WO-23, WO-24)

  - Add `docs/demo-script.md`: narrated end-to-end walkthrough covering install, wizard, status, logs, SSH, config, tunnel, MCP, backup, and teardown — with example output for evaluators and screencasters
  - Add `.github/ISSUE_TEMPLATE/`: bug report, feature request, and provider support request YAML forms; `config.yml` routes blank issues to docs and roadmap
  - README: replace split local/cloud quickstart sections with wizard-first quick start, manual-setup secondary; add per-app MCP config path table

## 1.2.0

### Minor Changes

- e16137f: Wave 8B: first-run setup wizard, config overlay, and macOS bootstrap (WO-02, WO-03, WO-16)

  ## New features

  - `clawops setup` — interactive wizard that guides first-time users through deploying OpenClaw and connecting it to an AI model, chat integrations, and local AI editors
    - Deployment type: cloud (AWS / GCP / Azure) or local/existing server over SSH
    - LLM provider selection (Anthropic, OpenAI, Bedrock, Ollama, and others from `spec/models.yaml`)
    - Chat integration selection via multi-select checkbox (Discord, Telegram, Slack, WhatsApp, Teams)
    - Secret collection: paste-and-save, environment variable ref, or file path
    - AI app MCP wiring via multi-select checkbox (Claude Desktop, Claude Code, Cursor, Windsurf) — uses absolute binary path so host apps can spawn it without inheriting the user's shell PATH
    - Generates a gateway auth token (`~/.clawops/secrets/GATEWAY_TOKEN_<stack>`) and applies it to the remote config; final output shows a tokenized dashboard URL
    - Local deploy path: bootstraps the host over SSH with streaming progress, applies the config overlay, and restarts the gateway with the auth token — process exits cleanly via `drainPool()`
    - Cloud deploy path: writes a `clawops-<stack>-plan.json` deploy plan and optionally calls `clawops apply`; `apply.ts` handles post-provisioning config overlay and gateway restart

  ## Bug fixes

  - Secrets passed through `resolveSecrets` on local deploy — API keys and integration tokens are resolved to real values before being written to the remote config instead of left as literal `$secret:` refs
  - Gateway token stored per-stack (`GATEWAY_TOKEN_<name>`) — multiple setup runs no longer clobber each other's tokens
  - SSH username defaults to current OS user (correct for localhost) instead of hardcoded `"ubuntu"`
  - Output-dir prompt skipped for local provider (always uses `"."`)
  - Duplicate `provider` field removed from models config overlay
  - Docker NOT_RUNNING on a non-localhost host now starts Docker on the remote server via SSH (`sudo systemctl start docker` with 90 s polling) instead of trying to start it on the user's machine
  - `gateway run` startup command updated to `--allow-unconfigured --token TOKEN` — the gateway requires `--allow-unconfigured` when model config has not passed its internal validation; omitting it caused a crash loop
  - Remote OS detection (`uname -s` over SSH) selects the correct OpenClaw config path (`~/.config/openclaw/config.json` on macOS vs `/home/clawops/openclaw.json` on Linux)
  - `sudo -S -p ''` suppresses the "Password:" prompt that was leaking into error messages
  - `execWithFallbackSudo` handles AWS Ubuntu hosts that SSH as a non-clawops user with passwordless sudo
  - macOS Docker PATH prefix injected in `restartGateway` SSH exec so `docker` is found in non-interactive sessions

## 1.1.0

### Minor Changes

- 9ea3b34: Add adoption documentation waves 1–3 and MCP registry metadata.

  **Wave 1 (R1, R2, R6, R8):** README rewrite with accurate plan/apply semantics and first-success quickstart (WO-01, WO-04); public roadmap and limitations pages (WO-22); provider capability matrix (WO-17).

  **Wave 2 (R1):** Local VM and VPS quickstart guide (WO-02); example OpenClaw model/channel configs (WO-03).

  **Wave 3 (R3):** MCP safety modes overview and tool risk matrix (WO-07); Claude Code and Cursor client integration guides with read-only/no-destructive setup (WO-08); audit log field reference and redaction guarantees (WO-09).

  **MCP registry:** Added `mcpName` field (`io.github.dfridkin/clawops`) to enable listing on the MCP Registry. The MCP server ships in `@clawops/cli` (invoked via `clawops mcp serve`) — no separate package.

## 1.0.0

### Major Changes

- 4119d20: v1.0 release — full CLI and MCP server for deploying self-hosted OpenClaw across AWS, GCP, Azure, and local VMs.

  - All CLI commands implemented: `up`, `down`, `destroy`, `plan`, `apply`, `status`, `ssh`, `logs`, `tunnel`, `config`, `agents`, `gateway`, `backup`, `stacks`, `doctor`, `mcp`
  - `--dry-run` support across all mutating commands
  - Full `doctor` surface: Node version, config, SSH key, provider credentials, Pulumi home
  - MCP server with stdio and HTTP transports; all operations exposed as typed MCP tools with R19 elicitation for destructive actions
  - Plan → review → apply discipline enforced for cloud provider deployments
  - Embedded Pulumi Automation API — no `pulumi` binary required
  - SSH transport via `ssh2` — no system `ssh` dependency
  - npm provenance via trusted publishing
