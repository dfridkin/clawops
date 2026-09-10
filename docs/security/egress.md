# Required outbound access

clawops deploys onto hosts whose egress you control. This is the list of destinations that
have to be reachable, from **where**, and **when** — and what the failure looks like when one
is missing, which is the part that costs time.

Two machines are involved and they need different things. Blocking the wrong one produces a
deployment that provisions cleanly and then does not work.

## From the deployed host

| Destination | When | Needed for |
|---|---|---|
| `download.docker.com` | first bootstrap only | installing Docker CE |
| your distro's package mirrors | first bootstrap only | `ca-certificates`, `curl`, `gnupg`, `lsb-release` |
| `ghcr.io` and its blob storage | bootstrap, and every `gateway update` | pulling `ghcr.io/openclaw/openclaw:<version>` |
| `clawhub.ai` | **during `apply`**, not at boot | installing model-provider plugins |
| `registry.npmjs.org` | **during `apply`**, when the config names a channel | installing channel plugins |
| `169.254.169.254` (link-local) | AWS only, when Bedrock is enabled | IMDSv2 region lookup |

## From your machine

| Destination | When | Needed for |
|---|---|---|
| your cloud provider's APIs | `plan`, `apply`, `destroy` | Pulumi |
| your state backend (S3, GCS, Azure Blob) | any stack operation | reading and writing stack state |
| `ifconfig.me` | only with `accessMode: auto` | resolving your public IP into a `/32` rule |
| `registry.npmjs.org` | installing clawops | `npm install -g @clawops/cli` |

## Plugins come from two different places

Model providers and chat channels are both install-gated plugins in 2.0, and they are **not
installed from the same host**:

| Plugin kind | Installed from | Example |
|---|---|---|
| model provider | `clawhub.ai` | `clawhub:@openclaw/deepseek-provider@2026.9.2` |
| chat channel | `registry.npmjs.org` | `@openclaw/discord` |

Allowing one does not allow the other. A host with ClawHub reachable and npm blocked installs
its model provider and silently fails to install its channel:

```
Failed to install @openclaw/discord: npm error code EAI_AGAIN
request to https://registry.npmjs.org/@openclaw%2fdiscord failed
```

**`openclaw channels add` exits 0 when that happens.** It prints the failure and returns to
its selection loop, so the exit code says nothing. clawops therefore installs channel plugins
with `openclaw plugins install`, which exits 1, and verifies against
`openclaw channels list --all --json` by asserting `installed: true`.

Both installs happen during `apply`, not at boot — so a blocked host fails in front of the
person running the deploy rather than at 3am.

## ClawHub is new in 2.0, and it is needed at deploy time

OpenClaw 2.0 made model providers **install-gated plugins**. Twenty-four are bundled in the
image — `anthropic`, `openai`, `google`, `ollama`, `openrouter` and others — but several are
not, and clawops installs those from ClawHub during `apply`:

```
Resolving clawhub:@openclaw/deepseek-provider@2026.9.2…
  ClawHub   https://clawhub.ai/plugins/@openclaw/deepseek-provider
Downloading plugin @openclaw/deepseek-provider@2026.9.2 from ClawHub…
Installed plugin: deepseek
```

**During `apply`, deliberately, and not at first gateway start.** Installing while the deploy
is still running means the failure surfaces to the person running the command, on a host that
still has egress, rather than at 3am on a locked-down box.

### What it looks like when `clawhub.ai` is blocked

```
Resolving clawhub:@openclaw/deepseek-provider@2026.9.2…
fetch failed | getaddrinfo EAI_AGAIN clawhub.ai | EAI_AGAIN
```

The install exits **1**. The gateway itself is unaffected and will start and report healthy —
with the twenty-four bundled providers and **without the one your config names**. A healthy
gateway with no usable model backend is the failure this ordering exists to prevent, so
clawops checks the installed provider IDs after the install and refuses to call the deploy
finished when a configured provider is missing.

If your network requires it, allow `clawhub.ai` for the duration of the deploy and remove it
afterwards. The gateway does not contact ClawHub at runtime.

## Deliberately not required

- **No clawops telemetry.** clawops makes no outbound call of its own from the deployed host.
- **No egress for `clawops tunnel`.** It forwards over the SSH connection you already have.
- **The gateway does not need inbound access.** It publishes on `127.0.0.1` by default — see
  the Firewall Model section in [aws.md](../providers/aws.md#firewall-model),
  [gcp.md](../providers/gcp.md#firewall-model) or [azure.md](../providers/azure.md#firewall-model).

## Adding a destination

Anything new goes in this table in the same change that introduces it, with its failure mode.
The `/audit-egress` skill checks for it.
