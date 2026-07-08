# @clawops/cli

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
