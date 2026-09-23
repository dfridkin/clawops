# @clawops/cli

## 2.1.0

### Minor Changes

- 9f8fe05: **`clawops harden` gains four Azure checks (WO-32), so the hardening report covers all three
  clouds rather than AWS and GCP only.**

  - **NSG audit** reports any inbound Allow rule on a clawops network security group that admits
    the whole internet, naming the port and saying when it is SSH or the gateway. Azure spells
    "anywhere" four ways — `*`, the `Internet` service tag, `0.0.0.0/0` and `::/0` — and `*` is
    what the portal writes by default, so all four count.
  - **Disk encryption** reports the gap beyond Azure's default rather than the default itself.
    Every managed disk is encrypted at rest with a platform key and cannot be otherwise, so the
    check reports whether encryption at host is on and whether the key is yours.
  - **Defender for Cloud** reports which relevant plans are on the free tier, which reports
    recommendations and protects nothing.
  - **JIT VM access** reports whether a policy covers the clawops VM, and says when the read
    failed because Defender for Servers Plan 2 is absent rather than leaving it ambiguous.

  All four are check-only, each for a stated reason: NSG rules are written from the plan and would
  be undone by the next apply; encryption at host needs the VM deallocated; Defender is billed per
  resource per month, so clawops will not put a recurring charge on a subscription; and JIT needs
  the paid plan and takes the NSG rules over from the plan that wrote them.

  A read that fails says why, because the fixes differ. Against a live subscription the Defender
  read returned 404 "Subscription Not Registered", and reporting that as a missing permission
  would send an operator to check RBAC when the fix is one `az provider register`. A 403 is
  reported as a permission; a 404 naming registration names the provider to register.

  JIT does not read an empty list as a definite negative. With `Microsoft.Security` unregistered,
  `jitNetworkAccessPolicies` answers 200 with an empty list while `pricings` under the same
  namespace answers 404, so the check confirms the provider is registered before concluding that
  no policy covers the VM.

  Resources are matched on their own name, never on their ARM id. An id carries the resource
  group, and clawops names that group `clawops-<stack>`, so matching the id would mark every
  resource in the group as ours.

- e698496: `clawops harden` gains three GCP checks, so the hardening report is no longer AWS-only on the
  cloud side.

  - **VPC firewall audit** reports any ingress rule on a clawops network that admits `0.0.0.0/0`
    or `::/0`, naming the port and saying when it is SSH or the gateway.
  - **Shielded VM** reports whether Secure Boot, vTPM and integrity monitoring are on.
  - **OS Login** reports whether it is enabled.

  All three are check-only, and the last two are check-only for reasons worth stating. Shielded VM
  settings cannot be changed while the instance is running, and clawops will not stop a gateway in
  order to harden it. Enabling OS Login makes the instance ignore metadata SSH keys, which is the
  key clawops authenticates with: every day-two command would stop working. A hardening step whose
  success locks the operator out is not one clawops will take, so it reports the posture and leaves
  the decision where it belongs.

  A check that cannot be performed reports as skipped, naming what was missing, rather than as a
  pass.

  Both lookups match the names Pulumi actually creates rather than the logical names in the
  program, which carry a generated suffix. Matching a substring also matched the project name, so
  in a project called `clawops-test` every rule on the default network was reported as a clawops
  rule open to the internet.

- 125255b: **GCP instances boot with Secure Boot on.** `debian-12` supports it; left unset, GCP enables vTPM
  and integrity monitoring and leaves Secure Boot off, which is what `clawops harden` reported on
  every GCP stack. Existing stacks get this as an update, not a replacement: the machine stops,
  the setting is applied, and it starts again with its boot disk and all OpenClaw state intact.

  **A plan that would replace a resource said nothing about it.** Pulumi marks a replacement with
  two characters and the plan parser matched only one, so a preview that would destroy the instance
  and its boot disk summarised as "0 to create, 0 to update, 0 to delete". Replacements are counted
  and listed now.

  **`clawops plan` warns when a plan changes a deployment that already exists.** A replacement
  names what is destroyed with it and points at `clawops backup create`; an instance update says
  the gateway goes down and that disk state survives. A first deploy warns about nothing.

- 32f5d7d: **Hardening, including the Tailscale flows, is reachable through MCP.** A new `clawops_harden`
  tool applies hardening modules, joins a stack to a tailnet and moves clawops onto that address,
  or takes it back off. `clawops_plan` gains the flags that decide who can reach a deployment:
  `sshCidr`, `gatewayCidr`, `publishGateway`, `openclawVersion` and `privateOnly`.

  Without these, the feature this release is named for could not be reached by an agent at all,
  and every plan an agent generated described a host nothing could connect to — deny-all is the
  right default, but a plan that cannot say otherwise is not a plan. `instanceType` also accepts
  the provider-native machine types the CLI has always taken, instead of only the five clawops
  aliases.

  The refusals travel with the capability. Both surfaces call the same flows, so an agent asking
  to leave the tailnet on a private-only stack gets the operator's refusal — and the plan and
  apply commands that reopen SSH first — rather than a way around it.

  **The audit log called every refusal a success.** A tool reports failure by returning
  `isError`, not by throwing, and the audit wrapper classified only the throw — so a declined
  destroy and a completed one were indistinguishable in the log R21 exists to produce. It now
  reads the returned result.

  Four tool descriptions named tools that do not exist (`clawops_ssh`, `clawops_agents_logs`,
  `clawops_gateway_update`, `clawops_gateway_stop`), so an agent following the advice in a
  "use X instead" line got a tool-not-found. They now name a real tool or say plainly that none
  exists. A test fails on any future description that points at a tool that is not served, and
  another fails on any CLI command that has neither a tool nor a written reason it needs none.

  `pnpm verify:mcp` drives the built server over stdio — the tool list a client receives, the
  annotations on it, the confirmation a destructive tool raises, and the rule that stdout carries
  protocol and nothing else — and runs in CI beside the packed-tarball check.

- 1d5aa17: **A stack can move onto its tailnet, close its public ports, and move back (WO-34, steps 4–6 and
  revert).**

  - **`clawops harden --tailscale`** joins the tailnet, then proves the new address works before
    clawops uses it. First it pins the host's keys for the tailnet address, read over the public
    connection that is already trusted. Then it opens a fresh SSH session to that address. Only if
    the session succeeds is the address recorded, and from then on every connection clawops makes
    to the stack goes there. The stack joins under its own name, `clawops-<stack>`, not the host's.
  - **`clawops plan --private-only`** writes a plan with no public SSH or gateway rules, and
    `clawops apply` closes the ports at the cloud firewall. Both refuse unless this machine can
    reach the stack over the tailnet at that moment. Apply checks again because the tailnet can
    drop between review and apply. Apply also refuses a plan made for an address the stack no
    longer has. This goes through the plan instead of `harden` because clawops keeps no stack
    config between runs, so an update started from `harden` would run with default settings and
    could replace the instance (ADR 0013).
  - **`clawops harden --tailscale-revert`** takes the host off the tailnet over its public
    address. Run over the tailnet, the command cuts its own connection, which hung for eight
    minutes on AWS. It then forgets the tailnet host key and points clawops back at the public
    address. On a private-only stack it refuses and prints the plan and apply commands that
    reopen SSH first.
  - **`clawops destroy`** now forgets the host keys for both addresses of a stack on its tailnet.
    It used to forget only the tailnet key, leaving the public address pinned for an instance
    that no longer existed, on an address the cloud reassigns.

  The reachability probe opens its own connection and closes it. Left in the connection pool it
  kept the process alive for the pool's five-minute idle sweep, so `plan --private-only` printed
  its plan and then appeared to hang. `clawops doctor` doesn't yet report tailnet status. Local stacks can join and repoint but have
  no private-only mode, because they have no plan/apply path.

- 1d5aa17: **`clawops harden` can put a host on your tailnet (WO-34, first part).**

  A new `tailscale` module installs Tailscale if it is absent, joins the tailnet, and reports the
  address it was given. It is off by default: every other module hardens a host that is already
  reachable, and joining a network the operator has to own an account on is not something to do
  as part of a `clawops harden` with no arguments.

  The auth key comes from `clawops secret set TAILSCALE_AUTH_KEY` and nowhere else, so a key never
  reaches a terminal scrollback or a CI log. Getting it to the host without exposing it takes two
  separate measures, because there are two separate exposures. It is passed to `tailscale up`
  through a file rather than an argument, so it is not in that process's argv; and it travels to
  the host over the SSH data channel as stdin rather than inside the command string, because sshd
  runs whatever string it is given as `$SHELL -c '<string>'` and every byte of that lands in the
  outer shell's argv. The staged file is created under `umask 077` rather than chmod-ed afterwards,
  and a trap removes it even if the command is interrupted. Anything shown after a failure has the
  key stripped from it.

  `RemoteExec` gains an optional `stdin`, routed to the transport's existing `execWithInput`, so
  any hardening module that needs to hand a secret to a host has a way that does not put it in a
  command line.

  The module only joins. Moving clawops onto the tailnet address, closing public access and undoing
  both are separate, explicit steps, because they are the ones that can lock an operator out of
  their own machine; see the `tailscale-cutover` note.

  The address is checked against 100.64.0.0/10 rather than taken on trust, because `tailscale ip
-4` prints nothing on a host that is not up, and an empty string arriving at a config rewrite as
  "the new SSH host" is a lockout.

### Patch Changes

- 349e303: The npm listing and the MCP registry entry now say the same thing, and both say that clawops is
  an MCP server as well as a CLI — the word someone searching a registry for this would type, and
  the one both descriptions left out.
- 389afa7: **The Dockerfile had never been built, and did not build.** `npm pack --pack-destination /out`
  fails with ENOENT because npm does not create that directory. The image exists so the Glama MCP
  directory can build the server and decide whether to list it; unable to build it, Glama inferred
  a spec of its own, ran `clawops` with no subcommand, got the CLI's help text where it wanted a
  handshake, and withheld the listing. One `mkdir` was the whole fix.

  `pnpm verify:docker` now builds the image and runs the MCP protocol probe against the running
  container — the same checks the local server passes, against the artifact a directory actually
  evaluates — and it runs in CI as a job of its own.

- d3a8522: **`clawops mcp serve` could not start.** The published 2.0.2 binary died on import before
  emitting a byte of protocol, so every MCP client that tried to connect got nothing. Half of what
  this package is was unusable.

  `ajv/dist/2020` resolves under CommonJS and not under ESM: ajv ships no `exports` map, so Node
  looks for a file of that exact name and only `2020.js` exists. The import now carries the
  extension.

  This is the same bug 2.0.1 shipped as `@pulumi/pulumi/automation`, in the other half of the
  product. `pnpm verify:pack` exists because of that one, and it missed this one because all four
  of its checks are commands that exit and print, and the MCP server is neither. It now speaks
  protocol to the packed tarball and fails if no handshake comes back. Reintroducing the bug leaves
  the four original checks green and fails only the new one.

- 1bbca31: The published package now carries its license, keywords and issue tracker, so npm shows what
  clawops is and searches for "openclaw", "mcp-server" or "pulumi" can find it. The repository also
  ships a Dockerfile and a `glama.json`, which is what the Glama MCP directory needs before it will
  list a server rather than withhold it.
- f2e0a04: The MCP registry manifest (`server.json`) is bumped when the version is, rather than rewritten in
  CI at publish time and never committed. The committed file had read `1.7.3` against a published
  `2.0.2`.

  The registry entry itself was further behind still: it has served `1.2.1` since that release,
  because the step that registers it had been failing for several releases without failing the
  run. Every MCP client that discovered clawops through the registry was offered a version from
  long before 2.0. This is the first release that updates it.

  `server.json` is now bumped by `pnpm version:packages` inside the Version Packages PR, the
  publish step refuses to register a manifest that disagrees with `package.json` instead of
  quietly rewriting it, and a test asserts the two agree.

## 2.0.2

### Patch Changes

- b18c334: Every cloud command failed on startup when clawops was installed from npm:

  ```
  Directory import '.../node_modules/@pulumi/pulumi/automation' is not supported
  resolving ES modules imported from '.../@clawops/cli/dist/chunk-*.js'
  ```

  `@pulumi/pulumi` publishes no `exports` map, so `@pulumi/pulumi/automation` resolves only under
  CommonJS rules. The three imports of it now name `@pulumi/pulumi/automation/index.js`.

  This affected 2.0.1 only, and only an installed copy — `doctor --provider`, `plan`, `apply`,
  `up` and `destroy` all stopped before doing anything. `clawops --version` worked, which is why
  it was missed. `pnpm verify:pack` now installs the packed tarball and runs it, in CI on every
  pull request.

## 2.0.1

### Patch Changes

- 7382185: `clawops apply` connects with the SSH key from your config.
- 9efa57b: `clawops doctor --provider aws` checks the account a deploy would land in: the account the
  credentials resolve to, the state bucket, and whether the instance type is offered in the
  region. It offers to create the bucket when it is genuinely absent, with versioning on and
  public access blocked.

  A check clawops could not perform — a denied listing — reports as a warning naming the error,
  rather than as a pass or a failure. Azure's VM size check uses the same state.

- 86eaf48: Azure accepts your `az login`. A service principal is no longer required.

  `clawops doctor --provider <name>` checks one cloud's credentials and account setup, with or
  without a stack of that provider.

- 179d84e: `clawops doctor --provider azure` checks the subscription, the resource providers a deploy
  needs registered, and the azblob credentials Pulumi authenticates to blob storage with.
  `clawops setup` runs the same checks and offers to register the providers, naming the change
  before making it.
- 2bd8331: Azure account checks include whether the VM size is offered to your subscription in the
  region, and list sizes that are when it is not.
- bf88ecb: A deploy that times out prints what the host was doing, from its bootstrap log, instead of
  only reporting the timeout.
- c56bf58: A host still installing Docker is treated as still booting, not as a failed deploy.
- d19d780: **The setup wizard writes model configuration OpenClaw accepts**, and installs the plugin your
  chosen provider needs.

  **Amazon Bedrock works.** clawops sets the transport Bedrock needs and resolves an inference
  profile against your deployment region, preferring your own geography, and records the concrete
  profile in the plan. This needs `bedrock:ListInferenceProfiles` on the identity running clawops.

  **`clawops setup` checks your cloud account is ready before provisioning anything**, and
  offers to fix what it safely can — enabling an API, creating a state bucket — naming the exact
  change first. A bucket clawops creates has versioning enabled. `clawops doctor` reports the
  same checks without offering to change anything.

  **`clawops doctor` validates cloud credentials.**

  **Cloud stacks are deployed with the ingress rules from the plan.**

  **Documentation:** the GCP guide names the credential source clawops actually reads and
  describes 2.0 firewall behaviour; the smoke-test plan covers 2.0, and `pnpm test:cloud` runs it
  against a real deployment and destroys it afterwards.

- 07146a9: `clawops apply` reports progress as it runs, instead of printing nothing for minutes on a
  scripted or CI deploy.
- 26c27c2: clawops tells a refused Docker socket from a missing container, and says which it found.
- 9decf31: `clawops destroy` forgets the instance's host key, so deploying onto an address the cloud has
  recycled no longer fails host-key verification.
- 5923bb6: `gcloud config set project` is honoured, as the GCP guide always said it was.
- aa3c7a4: `clawops init` keeps the stacks already registered in your config.
- 0080d2a: `clawops init` generates an SSH key clawops can read.

  If you ran `clawops init` before this release, `clawops doctor` reports whether your key is
  usable and what to do if it is not.

- 87b6dcd: `clawops logs` reads from the gateway on AWS.
- 0080d2a: `clawops plan` → `clawops apply` provisions a cloud stack and deploys OpenClaw onto it.

  - Stack configuration is written once, by one writer shared between preview and apply.
  - The plan records the public key that may log in, resolved from your configured key.
  - clawops creates and stores the passphrase a self-managed state backend requires
    ([ADR 0011](https://github.com/dfridkin/clawops/blob/main/docs/decisions/0011-state-passphrase.md)).

- bc5a4fc: `clawops plan` stops when it cannot open the state backend, and names the cause.
- 1ea868e: `clawops plan` takes `--ssh-cidr`, `--gateway-cidr` and `--publish-gateway` to say who may
  connect. `auto` resolves this machine's address while the plan is written, and a plan that
  admits nothing says so.
- bd614fd: `clawops plan --instance-type` takes a clawops alias (`micro`–`gpu`) or a machine type your
  cloud names itself, and the plan records the concrete type the cloud will be asked for.
- f35c64b: `clawops doctor --instance-type <size>` points the account checks at the size you are about to
  deploy rather than the provider default, and `--provider` checks the provider you name rather
  than the one your default stack happens to use.
- 756c851: clawops installs the Pulumi CLI it needs into `~/.clawops/.pulumi-cli` the first time it needs
  one, announcing the one-time download, and uses a compatible `pulumi` already on `$PATH`
  instead when there is one. `$PATH` is never edited. `clawops doctor` reports which one it
  found, from where, and at what version. See
  [ADR 0010](https://github.com/dfridkin/clawops/blob/main/docs/decisions/0010-pulumi-cli-bootstrap.md).
- 5906e0c: `doctor --stack`, `ssh`, `logs`, `gateway`, `config` and `agents` work against a deployed
  stack.
- 3f8a9cf: `clawops plan` resolves the provider before calling it.
- 344822d: A deploy reuses the SSH session it just proved was working.
- 9efa57b: The setup wizard checks the machine size you chose, not the provider default.

  A check the wizard could not perform is reported as unanswered rather than counted as a
  failure, and it offers no fix for a check it could not make.

- 4c71175: Cloud Storage bucket names containing dots may be up to 222 characters, with each dot-separated
  part capped at 63. clawops was rejecting them at 63.
- 4a2564f: clawops names the state backend after the account it is deploying into, instead of asking you
  for a name or writing a placeholder:

  |       | derived name                         |
  | ----- | ------------------------------------ |
  | AWS   | `clawops-state-<accountId>-<region>` |
  | GCP   | `clawops-state-<projectId>`          |
  | Azure | `clawops-state`                      |

  A name you type instead is checked against the rules of the cloud that has to accept it.
  `clawops init` with no credentials and no `--state` stops and names the credential it needed,
  rather than registering a stack that cannot deploy. `--state` still takes any URL verbatim and
  existing configs are untouched. See
  [ADR 0012](https://github.com/dfridkin/clawops/blob/main/docs/decisions/0012-state-bucket-naming.md).

- 952eb88: `clawops up` deploys to AWS, GCP and Azure, running the same plan → apply path as
  `clawops apply`. It gains `--ssh-cidr`, `--gateway-cidr` and `--publish-gateway` with it.

  Deploys pin the account they were planned against: `gcp:project` on GCP,
  `azure-native:subscriptionId` on Azure.

- 2185853: `clawops apply` waits for the gateway to answer before reporting success.
- 5d28a6d: `clawops apply` waits for the instance to accept SSH before reporting success.

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
