# @clawops/cli

## 2.0.1

### Patch Changes

- 7382185: **`clawops apply` built its SSH connection with an empty key path.**

  ```
  Cannot read SSH private key at : ENOENT: no such file or directory, open ''
  ```

  `getConnectionInfo` reads `privateKeyPath` and `knownHostsPath` out of the object it is handed,
  and a stack's outputs do not contain them — they are the operator's, from
  `~/.clawops/config.json`. Every other caller merges them in first:

  ```ts
  ctx.adapter.getConnectionInfo({ ...base, privateKeyPath: ctx.config.ssh.keyPath, … })
  ```

  apply passed raw stack outputs. That was true of its config-overlay step from the beginning —
  so any plan carrying `openclaw.config` would have failed on a real deployment — and the new
  readiness wait inherited the same call shape. Both go through one helper now, which also
  expands `~`, since `ssh2` opens the path verbatim.

- 86eaf48: **clawops refused an `az login` it was about to rely on.**

  The Azure credential check accepted only a service principal, OIDC, or a managed identity:

  ```
  No Azure credentials found. Set AZURE_CLIENT_ID + AZURE_TENANT_ID + AZURE_CLIENT_SECRET …
  ```

  Pulumi's `azure-native` provider falls back to the Azure CLI when none of those are set, so
  `az login` was enough to deploy and not enough to pass `clawops doctor` — the same shape as the
  GCP check that told operators to run `gcloud config set project` and then ignored the result.

  clawops reads the CLI's own `azureProfile.json` now (honouring `AZURE_CONFIG_DIR`), the way the
  GCP adapter reads Application Default Credentials off disk. The subscription a deploy lands in
  resolves as `ARM_SUBSCRIPTION_ID`, then `AZURE_SUBSCRIPTION_ID`, then the CLI's default —
  Pulumi's own order, so `doctor` reports what `apply` will use.

  **`clawops doctor --provider <name>` now exists.** `docs/providers/azure.md` has documented that
  flag from the beginning and there was no such flag: the only way to ask "am I set up for
  Azure?" was to register a stack first and read the answer off a check about something else. It
  works with or without a stack.

- 179d84e: **A fresh Azure subscription fails partway through a deploy, and nothing said so.**

  Azure registers resource providers per subscription, and a new one has none:

  ```
  Microsoft.Compute: NotRegistered
  Microsoft.Network: NotRegistered
  Microsoft.Storage: NotRegistered
  ```

  The first sign was ARM refusing mid-deploy with `The subscription is not registered to use
namespace 'Microsoft.Compute'` — the Azure counterpart of GCP's disabled-API failure, which
  `gcpPreflight` has checked since 2.0. Azure had no preflight at all.

  `clawops doctor --provider azure` now checks the subscription resolves, that Compute, Network
  and Storage are registered — offering to register them, naming the subscription it will change
  — and that the azblob state backend is configured.

  That last one is the check that looks least like its cause: **Pulumi's azblob backend does not
  use your `az login`.** It authenticates with `AZURE_STORAGE_ACCOUNT` plus a key or SAS token,
  so every credential check can pass and a deploy still fail to open its own state.

- 2bd8331: **The VM size clawops asks for on Azure may not be offered to your subscription.**

  Azure gates SKU families per subscription and region. The subscription this was first run
  against was offered **no B-series size at all** in `eastus` — which is every non-GPU size
  clawops names (`Standard_B1s`, `B2s`, `B4ms`, `B8ms`). The deploy failed with:

  ```
  Status=409 Code="SkuNotAvailable" … 'Standard_B2s' is currently not available in location 'eastus'
  ```

  after the virtual network, NSG, public IP and NIC had been created.

  `clawops doctor` checks the default size against what the subscription is actually offered, and
  names alternatives of a similar shape:

  ```
  ✗  Standard_B2s is available in eastus
     … Available instead: Standard_D2ads_v7, Standard_D2als_v7, Standard_D2as_v7 —
     pass one with `clawops plan --instance-type <size>`
  ```

  The size map is unchanged on purpose: availability is per-subscription, so a map that works for
  one account breaks another. clawops names what your account can have instead of guessing.

- bf88ecb: **A deploy that times out now says what the host was doing.**

  When the gateway never appears, clawops used to report:

  ```
  The OpenClaw gateway did not answer within 600s. Container: not found.
  The instance is up — `clawops logs --stack <name>` shows what it is doing.
  ```

  — advice that assumes the instance is still there to look at. An automated run destroys it on
  the way out, and the evidence goes with it. That happened on the third Azure end-to-end run: the
  container never appeared, and by the time anyone could look, the teardown had deleted the VM.

  The timeout error now carries the last of the host's bootstrap log — cloud-init's output, or
  GCP's startup-script unit — read over the connection that is already open. The diagnostic
  swallows its own failures: it runs when something has already gone wrong, and a diagnostic that
  throws would replace the real error with its own.

- c56bf58: **A host still installing Docker is not a failed deploy.**

  The previous release in this series taught clawops to stop conflating "there is no container"
  with "clawops could not ask". Its first real use raised:

  ```
  Could not ask the host about the openclaw container: bash: line 1: docker: command not found.
  ```

  which was accurate and the wrong response. A fresh VM has no Docker for the first minute or so —
  the bootstrap installs it — so that is the deployment working, not failing.

  The readiness wait now distinguishes a host that is still coming up (`command not found`, the
  daemon not yet running) from one that will not answer (a socket that refuses this session, which
  `sudo` has already failed to get past). It waits through the first and stops on the second, and
  a timeout reports whichever kept happening.

- d19d780: **Bedrock never worked, and the config the setup wizard wrote was invalid for every provider.**

  ## The wizard wrote a shape OpenClaw does not have

  ```jsonc
  "models": { "provider": "bedrock", "modelId": "anthropic.claude-sonnet-4-6" }
  ```

  The schema's key is `models.providers.<id>`. Validation rejected the old form outright —
  `unknown key "provider"` — so this affected **every** provider, not just Bedrock.

  Worse, `requiredPlugins` reads `models.providers` to decide which plugins to install. With the
  wrong key it found nothing, so the plugin for whichever provider you chose was never
  installed — and on Bedrock an uninstalled provider plugin exits the gateway **78**.

  ## Bedrock needed two things nobody had set

  **The transport.** Bedrock is a plugin provider, and unlike bundled ones it does not resolve
  its own — without `api: "bedrock-converse-stream"` every call routed through the
  OpenAI-compatible transport and died on _"requires an explicit base URL"_.

  **An inference profile.** Bedrock refuses bare foundation-model ids for on-demand inference:

  ```
  Invocation of model ID anthropic.claude-haiku-4-5-... with on-demand throughput isn't
  supported. Retry your request with the ID or ARN of an inference profile...
  ```

  All ten Bedrock models in the catalog were bare ids. The usable id — `us.anthropic.…` — is
  region-dependent, so clawops now resolves it against the deployment region at plan time and
  records the concrete profile in the plan. It prefers your own geography, falls back to a
  `global.` profile, and **refuses rather than routing inference to another continent**.

  This needs `bedrock:ListInferenceProfiles` on the identity running `clawops`.

  Verified end to end against real Bedrock.

  ***

  **Documentation corrections found while writing the cloud end-to-end plan.**

  `docs/providers/gcp.md` listed `CLOUDSDK_AUTH_ACCESS_TOKEN` as a supported credential source.
  The adapter reads `GOOGLE_OAUTH_ACCESS_TOKEN`; the other is gcloud-internal. It also still said
  the GCP firewall opens both ports to `0.0.0.0/0` with per-CIDR "on the roadmap" — per-CIDR
  landed in 2.0, and since 2.0 no gateway rule is created at all under loopback publishing.

  The smoke-test plan was 1.x-era throughout. It now leads with what 2.0 changed and the
  assertions that follow from it, and `pnpm test:cloud gcp|azure` runs them against a real
  deployment and destroys it afterwards — including when an assertion fails.

  ***

  **`clawops setup` checks your cloud account is ready, and offers to fix what it can.**

  A GCP project with working credentials and the Compute API disabled passes every check clawops
  used to make, and then fails partway through a deploy:

  ```
  Compute Engine API has not been used in project <id> before or it is disabled
  ```

  The wizard now checks before provisioning anything — required APIs enabled, the state bucket
  present, the project resolvable — and **asks** before changing anything, naming the exact
  mutation:

  ```
  ? Fix this now? Enables compute.googleapis.com on project my-project (Y/n)
  ```

  `clawops doctor` reports the same checks without offering to change anything.

  Neither is infrastructure, which is why neither lives in the Pulumi program: the state bucket
  has to exist before Pulumi can run at all, so a deploy cannot create it on its way past. When
  clawops creates one it enables versioning — Pulumi state with no history is a stack that can
  no longer be updated or destroyed.

  ***

  **`clawops doctor` never validated cloud credentials.**

  `registerProvider` existed and was called by nothing, so `getProvider` threw for every
  provider. Doctor's Credentials section reported this for any cloud stack:

  ```
  ✗ gcp  stack "prod" — No provider adapter registered for 'gcp'. Run `clawops init`…
  ```

  Deploys were unaffected — `up`, `plan` and `apply` resolve the adapter directly — so the only
  symptom was a diagnostic that said something alarming and untrue. Adapters register on import
  now, and doctor validates credentials as it always claimed to.

  ***

  **Every cloud stack was deployed with no ingress rules at all.**

  `clawops apply` validated the plan's `network.allowedSshCidrs`, printed them in the plan
  summary, and then never passed them to Pulumi. The programs read them from stack config, so
  they resolved empty:

  ```
  resolveIngressCidrs('restricted', '', '', …) → []
  ```

  Not a narrower rule — **none**. clawops creates its own VPC, so nothing else opened SSH, and a
  freshly deployed instance was unreachable by `ssh`, `logs`, `tunnel`, `harden` and every other
  day-two command. The plan said who could connect and apply ignored it.

  Fixed, with the deny-all default (`accessMode: restricted`) passed explicitly alongside.

- 07146a9: **A scripted or CI `clawops apply` was silent for minutes.**

  The readiness waits report what they are waiting for through `onOutput`, which the apply command
  uses to set the spinner's text — and a spinner renders nothing when the output is not a
  terminal. So the one case those messages exist for, an operator watching a deploy that takes
  four minutes, showed nothing at all.

  Waiting notes now travel on their own `onProgress` channel — at most one every 30 seconds, as
  against Pulumi's hundreds of lines — and are printed outright when no spinner can show them.

- 26c27c2: **A healthy deployment could be reported as missing, indefinitely.**

  Every Docker probe was written like this:

  ```bash
  docker inspect openclaw --format '{{.State.Status}}' 2>/dev/null || echo 'not found'
  ```

  which discards stderr and exits 0 whatever happened. clawops escalates to `sudo` when a command
  looks like it was refused the Docker socket — and it tests the exit code first, so a command
  that always succeeds never escalates. The permission error was laundered into a confident
  `not found`, and the session cached that `sudo` was not needed.

  On a real deploy, `clawops apply` waited ten minutes for a container that was `Up 9 minutes
(healthy)` throughout. It is intermittent because the SSH user's membership of the `docker`
  group is fixed when the session opens, and clawops connects as soon as `sshd` answers —
  sometimes before the host has run `usermod`.

  A refusal and an absence are now different answers everywhere they are asked: `doctor` says
  `could not ask docker — permission denied` rather than claiming the container is gone,
  `gateway status` will not print "not running" when it does not know, `monitor` shows
  `unreachable`, and the readiness wait stops on a refusal instead of polling through it.

- 9decf31: **Redeploying onto a recycled cloud address failed host-key verification.**

  A cloud hands addresses back out. Destroy a stack, deploy another, and the new instance can
  land on the address the old one just released — with a different host key:

  ```
  ERROR  SSH to 136.116.28.199:22 failed for a reason waiting will not fix:
         Host denied (verification failed)
  ```

  Trust-on-first-use refused, correctly, over a machine that no longer existed.

  clawops creates these hosts and destroys them, so at the moment it destroys one, that host's
  pinned key is stale by construction. `clawops destroy` now forgets it. Every other entry, every
  comment and the rest of the file are left alone — `ssh.knownHostsPath` may be your own
  `~/.ssh/known_hosts`.

  When a mismatch does happen, the error names the file and gives the exact `ssh-keygen -R` line,
  and still says that an address changing hands unexpectedly is the one case where you should not
  clear it.

- 5923bb6: **`gcloud config set project` — the thing clawops told you to do — did nothing.**

  The GCP preflight check resolved the project from four environment variables and printed this
  when it found none:

  ```
  ✗ GCP project is set   No project resolved. Set GOOGLE_CLOUD_PROJECT, or run
                         `gcloud config set project <id>`.
  ```

  The second half of that remedy was never implemented: nothing read gcloud's configuration, so
  an operator who followed the advice saw the same failure and no reason why.

  clawops now reads `core/project` from the active gcloud configuration (honouring
  `CLOUDSDK_CONFIG` and `active_config`), after the environment variables and including
  `GOOGLE_PROJECT`, which the Pulumi GCP provider checks first and clawops did not check at all.

  `apply` also pins the resolved project as the stack's `gcp:project`, so a deploy lands in the
  project whose APIs and state bucket `doctor` verified rather than in whichever one the
  environment names at apply time.

- aa3c7a4: **Registering a second stack deleted the first.**

  `clawops init` built a fresh config object with a single `stacks` entry and wrote it over
  `~/.clawops/config.json`:

  ```bash
  clawops init --provider gcp --stack staging --force
  ```

  That dropped every other stack — and with it their `stateUrl`, the only pointer to where that
  stack's Pulumi state lives. The infrastructure stayed up and clawops could no longer list,
  reach or destroy it. There was no other way to register a second stack.

  `init` is additive now: a stack that is not in the config is added, no `--force` required.
  `--force` is needed to overwrite a stack that _is_ there, since changing a registered
  `stateUrl` orphans state just as thoroughly. Config outside `stacks` survives, and the default
  moves to the stack just initialised.

  Related: `clawops plan` for an unregistered stack emitted a plan with an empty `diff` and a
  warning far up the output, then failed at `apply` — after the plan had been reviewed and
  approved. The preview's catch swallowed the error that said so. A `UsageError` now fails the
  plan; a genuine preview failure is still tolerated.

- 0080d2a: **`clawops init` generated an SSH key that clawops cannot use.**

  It called `crypto.generateKeyPairSync('ed25519', { privateKeyEncoding: { type: 'pkcs8' } })`,
  which writes a PKCS#8 PEM. That is a valid ed25519 key, and neither `ssh2` — the library every
  clawops SSH operation uses — nor OpenSSH itself can read it:

  ```
  $ ssh-keygen -y -f ~/.clawops/id_ed25519
  Load key "~/.clawops/id_ed25519": invalid format
  ```

  So `init` produced a key the tool that produced it could not use, and every `ssh`, `logs`,
  `tunnel` and `harden` against a stack deployed with it would have failed at connect time.
  `doctor` reported `✓ SSH key` because it checked the file was readable.

  `init` now uses `ssh-keygen`, as the setup wizard already did, writes the `.pub` beside it, and
  refuses with instructions if `ssh-keygen` is unavailable rather than writing a config that
  points at a key that does not exist. `doctor` parses the key rather than stat-ing it.

  **If you ran `clawops init` before this release**, check `clawops doctor`. If it reports the key
  is unusable, regenerate it:

  ```bash
  ssh-keygen -t ed25519 -f ~/.clawops/id_ed25519 -N '' -C clawops
  ```

  An already-deployed instance keeps the old public key in its `authorized_keys`; redeploy or add
  the new public key to the host.

- 87b6dcd: **`clawops logs` never read from the gateway on AWS.**

  The probe deciding whether the gateway can serve its own logs was:

  ```bash
  docker exec openclaw openclaw logs --limit 1 >/dev/null 2>&1 && echo ok || echo no
  ```

  It discards stderr and exits 0 whatever happened, so `execPrivileged` — which tests the exit
  code before deciding a command was refused Docker access — never escalated to `sudo`. On AWS the
  SSH user is `ubuntu`, who is not in the docker group, so `docker exec` was always refused, the
  probe could only answer "no", and `logs` silently read container output instead.

  GCP and Azure connect as `clawops`, who is in the group, so this was invisible until the first
  AWS deploy. The probe reports through its exit code now, and keeps stderr, which is what says
  why it failed.

- 0080d2a: **`clawops plan` → `clawops apply` had never deployed anything.** Three faults, each hiding the
  next, found by running the path end to end for the first time.

  **Stack config was written twice and disagreed.** `generatePlan` set three keys before its
  preview; `applyPlan` set six. Neither set `sshPublicKey`, which every cloud program requires:

  ```
  error: Stack config "sshPublicKey" is required for the GCP adapter.
  ```

  So the preview failed on every cloud plan ever generated — surfaced as one line of warning and
  an empty `diff` section — and apply could not create an instance. Both now write stack config
  through the same function, so a preview shows what an apply would do.

  **The plan did not record which key may log in.** It does now, in `spec.ssh.publicKey`,
  resolved from `ssh.keyPath`: the `.pub` beside the private key, or derived from the private key
  through `ssh2` when there is none.

  **A self-managed state backend needs a passphrase.** `gs://`, `s3://` and Azure Blob have no key
  service, so a new stack cannot create a secrets manager without one. clawops generates one at
  `~/.clawops/secrets/pulumi-passphrase` (mode `0600`) and yields to `PULUMI_CONFIG_PASSPHRASE`
  when the operator sets it. **Back that file up** — losing it makes that stack's secrets
  unreadable. See ADR 0011.

  Also fixed:

  - `clawops doctor` checks that your SSH key is one `ssh2` can use. A readable PKCS#8 PEM passed
    the old check and then failed at every connect. It also reports the Pulumi CLI and the state
    passphrase.
  - Egress-IP detection asks for `text/plain` and validates the answer. `ifconfig.me` serves an
    HTML page to anything that does not look like curl, so the "detected IP" was a 4KB document
    on its way into a firewall rule.
  - A preview no longer counts the same resource once per section: "7 to create" for a stack that
    creates four.

- bc5a4fc: **`clawops plan` wrote a plan even when its state backend did not exist.**

  Opening the stack and previewing it failed into the same `catch`, which wrote a warning and
  carried on. A missing S3 bucket produced:

  ```
  error: could not list bucket: NoSuchBucket: The specified bucket does not exist
  ✔ Plan generated
  ✓ Plan written to /tmp/plan.json
  ```

  and exit 0. `doctor` said the provider was fine, `plan` said the plan was fine, and `apply` then
  failed with a raw Pulumi error naming a bucket clawops had never mentioned.

  A backend that cannot be opened now ends the command and names the cause — not Pulumi's `code:
-2` wrapper, which is what the first line of its error actually says. A preview that fails on a
  stack which opened normally still writes the plan without a diff, as before.

- 1ea868e: **`clawops plan` could not say who is allowed to connect.**

  The deploy-plan schema has carried `network.allowedSshCidrs` since the beginning and the setup
  wizard fills it, but the non-interactive command had no flag for it and fell through to:

  ```ts
  const network = intent.network ?? {
    allowedSshCidrs: [],
    allowedGatewayCidrs: [],
  };
  ```

  So every plan generated outside the wizard described a host that admits nothing — including
  clawops itself, whose `ssh`, `logs`, `tunnel` and `harden` all run over SSH.

  `plan` now takes `--ssh-cidr`, `--gateway-cidr` and `--publish-gateway`. `--ssh-cidr auto`
  resolves this machine's public IP to a `/32` **while the plan is generated**, so the plan
  records the address it admits rather than deferring the question to apply time. A bare IP is
  refused rather than assumed to be a `/32`, and a failed `auto` lookup stops the plan rather
  than falling back — neither an empty list nor `0.0.0.0/0` is a safe guess.

  Deny-all remains the default (N10). A plan that admits nobody is still valid, and now says so:

  ```
  [clawops] warning: network.allowedSshCidrs is empty, so this deployment will accept no SSH
  connections at all …
  ```

- bd614fd: **`clawops plan` named an instance size no cloud has.**

  The plan wrote the clawops size name — `micro`, `small`, `medium`, `large`, `gpu` — straight
  into `spec.instanceType`, and apply handed it to the provider verbatim:

  ```
  Error 400: Invalid value for field 'resource.machineType':
  'projects/…/machineTypes/small'. Machine type with name 'small' does not exist in zone 'us-central1-a'.
  ```

  — after the network, subnet, address and firewall rule had already been created. The same on
  AWS, where the type is `t3.small`, and on Azure, where it is `Standard_B2s`.

  Every adapter has carried `normalizeInstanceType` from the start and `clawops up` calls it.
  `generatePlan` did not, though `spec/deploy-plan.schema.json` describes the field as a
  _"provider-native instance type. Adapter normalizes from clawops alias before plan emission"_.

  It does now, so the plan records what the cloud will actually be asked for. A value that is not
  one of the five sizes is still passed through — an operator naming a real machine type knows
  their cloud's catalogue better than our table does — with a note on stderr saying so.

- f35c64b: **`clawops doctor --instance-type <size>`**, so account checks ask about the size you are
  actually deploying.

  Azure offers SKU families per subscription, so "is this size available here" can only be
  answered about a specific size. The check used the provider's default, which is right for a
  plain `clawops up` and wrong for anyone passing `--instance-type`: a healthy deployment using an
  available size was reported as broken, because a size it does not use is unavailable.

  The cloud end-to-end script also preflighted the wrong cloud. `clawops doctor` with no arguments
  checks whichever provider the default stack uses, and the default moves — deleting the script's
  own throwaway stack hands it to whichever stack is left. So the second Azure run preflighted
  GCP, passed, and deployed without a single Azure check having run. It uses `--provider` now.

- 756c851: **Cloud deployments could not work on a machine without Pulumi installed.**

  clawops has always said you do not install Pulumi. The Automation API it drives is not an
  embedded engine, though — it spawns the `pulumi` binary for every operation:

  ```js
  const command = opts?.root
    ? path.resolve(path.join(opts.root, "bin/pulumi"))
    : "pulumi";
  ```

  With none on `$PATH`, every stack command stopped at `spawn pulumi ENOENT`, before any provider
  code ran, naming a tool the docs said was not required.

  The promise is now true rather than merely stated: clawops installs the CLI matching its
  bundled SDK into `~/.clawops/.pulumi-cli` the first time it needs one, announcing the one-time
  download on stderr. A compatible `pulumi` already on `$PATH` is used instead, and `$PATH` is
  never edited either way. `clawops doctor` reports which one it found, from where, and at what
  version.

  See ADR 0010, which supersedes ADR 0006.

- 5906e0c: **Day-two commands failed with an error about provider loading.**

  `buildContext().adapter` was a proxy that loaded the provider module on its first _async_ call,
  so every synchronous method on it threw until something else had triggered that:

  ```
  ✗  Connection   Provider not yet loaded. Call getStack() first.
  ```

  Eighteen call sites depended on that ordering and nothing enforced it. `clawops up` worked
  because it awaits `validateConfig()` a few lines earlier; `clawops plan` did not, and against a
  freshly deployed instance `doctor --stack`, `ssh`, `logs` and `gateway restart` all failed with
  an error about provider loading rather than about the instance.

  Adapters are registered when imported now, and the context hands back the real one. They are
  small, and the Pulumi packages they eventually need load inside the program function, so
  nothing heavy moves to startup.

- 3f8a9cf: **`clawops plan` failed with "Provider not yet loaded. Call getStack() first."**

  `buildContext().adapter` is a proxy that loads the provider module on its first _async_ call.
  Its synchronous methods — `normalizeInstanceType`, `defaultRegion`, `getConnectionInfo` —
  throw until that has happened. `clawops up` works only because it happens to
  `await validateConfig()` a few lines earlier; nothing says so, and nothing enforced it.

  `generatePlan` needed the size table and no stack, so it called the proxy directly and the
  plan died. `loadAdapterModule(provider)` is now exported for exactly this: callers that need a
  synchronous adapter method without needing a stack await it, instead of depending on call
  order. The proxy's error message names it.

- 344822d: **A deploy could fail one line after reporting SSH was up.**

  ```
  Waiting for 100.56.120.109:22 to accept SSH — a new instance takes a minute.
  SSH is up after 2 attempts.
  ✖ Deployment failed
    SSH connection failed: Timed out while waiting for handshake
  ```

  The readiness wait proved the host was accepting SSH, closed that session, and `apply` then
  opened a second one for the gateway wait — a fresh handshake against a host that had started
  accepting connections moments earlier, with no retries behind it. The wait retried; the
  connection immediately after it did not.

  `waitForSsh` hands back the session it proved with, and the gateway wait uses that. One
  connection instead of two, and no unguarded handshake in between.

- 952eb88: **`clawops up` could not deploy to a cloud at all.**

  There were three implementations of deploying — `clawops up`, `clawops apply`, and the
  `clawops_up` MCP tool. The two that were not the plan path each wrote three pieces of stack
  config and nothing else:

  ```ts
  await stack.setConfig('region', …)
  await stack.setConfig('instanceType', …)
  await stack.setConfig('openclawVersion', …)
  ```

  No `sshPublicKey`, so every cloud program refused to run — the same failure that made
  plan → apply impossible. No firewall rules, no GCP project pin, no readiness waits, and no flag
  for who may connect. The setup wizard builds a plan and applies it, so nothing exercised the
  path the README calls the primary command.

  `up` and the MCP tool now build a plan and apply it. They gain `--ssh-cidr`, `--gateway-cidr`
  and `--publish-gateway`; `--gateway-port` applies to cloud stacks rather than local only; and
  `--instance-type` accepts a provider-native machine type, which on Azure is often the only kind
  on offer. `--no-wait` returns as soon as the cloud API accepts the resources.

  **Azure deploys now pin their subscription.** `azure-native` resolves it from the environment or
  the CLI's default, so an `az account set` between the preflight and the apply moved the deploy
  to another subscription silently — the hazard `gcp:project` pinning already covered for GCP.

  `pnpm test` also refuses to run while the mutation checker has a file mutated, rather than
  reporting failures about source nobody wrote.

- 2185853: **`clawops apply` reported success before OpenClaw existed.**

  Waiting for SSH is not the same as waiting for the deployment. The startup script pulls a ~3GB
  image, so for the first minutes after a successful apply:

  ```
  Remote health
  ✗  Container    not found
  ✗  Gateway      no response from the gateway
  ```

  and `logs`, `gateway`, `config`, `agents` and `doctor --stack` all fail at whatever you try
  first.

  apply now waits for the gateway to answer `/startupz` — the probe `doctor` already uses —
  before reporting success, and says what it is waiting for every half minute rather than going
  silent through a long download. A running container is not accepted as a working gateway: that
  distinction is why `/startupz` exists. The container's state is read alongside the probe, so a
  timeout can say whether an image was still downloading or a container started and exited; both
  look like "no response" from outside and need different answers.

- 5d28a6d: **`clawops apply` reported success while the instance was still booting.**

  Pulumi returns as soon as the cloud API accepts the resource; `sshd` starts a good half-minute
  later. apply printed its success line, the gateway URL and the public IP at that moment, and
  every command run after it failed:

  ```
  ✗  Connection   SSH connection failed: connect ECONNREFUSED 34.70.45.162:22
  ```

  So did apply's own config-overlay step, which connects immediately after `stack.up` — any plan
  carrying `openclaw.config` raced the boot. Nothing in clawops waited for anything.

  apply now waits for the host to accept SSH before reporting success, saying so once if the wait
  is more than momentary. `ECONNREFUSED` and handshake timeouts are expected in the first minute
  of a VM's life and are retried; a host-key mismatch or an unreadable key is raised immediately,
  because waiting will not fix it.

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
