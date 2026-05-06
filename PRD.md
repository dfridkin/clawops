# clawops — Product Requirements Document

**Version:** 0.2 (DRAFT)
**Last updated:** May 2026
**Status:** Pre-implementation; ready for kickoff

---

## 1. Summary

**clawops** is a provider-agnostic command-line tool for deploying, configuring, and operating self-hosted OpenClaw instances across AWS, GCP, Azure, and local VMs. It abstracts cloud-specific provisioning behind a unified noun/verb interface modeled on `kubectl`/`flyctl`, uses the Pulumi Automation API for idempotent infrastructure management, stores deployment state in cloud-native blob storage, and exposes every operation as both a CLI command and an MCP tool — enabling direct human use, scripting, CI integration, and AI-agent-driven deployment.

**The gap it fills:** every existing OpenClaw deployment path is either cloud-specific (Yash-Kavaiya/openclaw-bedrock-ec2 for AWS, official Azure Bicep scripts), platform-specific (ClawHost on Hetzner only), Kubernetes-bound (openclaw-rocks/openclaw-operator, two community Helm charts), or fully managed SaaS (clawctl.com, KiloClaw). No open-source tool unifies provisioning + lifecycle management + remote agent interaction across providers under a single CLI with first-class agent integration.

**Strategic positioning vs. Clanker:** Clanker is a natural-language AI agent for general cloud ops with incidental OpenClaw recognition (PR #102). clawops is a deterministic, OpenClaw-first deployment tool. Rather than competing, clawops exposes an MCP server so Clanker (and any other AI agent) can drive clawops-managed deployments — making clawops the *infrastructure primitive* and Clanker one of many possible clients.

---

## 2. Goals & Non-Goals

### 2.1 Goals (v1)

- **Single install, all providers:** one npm package, no extra binaries required at install time
- **Full lifecycle ownership:** provision → configure → deploy → monitor → update → destroy
- **Developer-native UX:** composable commands, `--json` output, stdin/stdout piping, CI-friendly exit codes
- **Agent-native UX:** MCP server (embedded `clawops mcp serve` + standalone `@clawops/mcp-server`) exposing every operation as a typed tool
- **State safety:** Pulumi-managed stacks per deployment, stored in cloud blob; idempotent up/down
- **Remote management:** log tailing, config CRUD, agent lifecycle, gateway tunneling over SSH
- **Plan-then-apply discipline:** all destructive operations route through a reviewable Maker plan artifact (borrowed from Clanker's pattern)

### 2.2 Non-Goals (v1)

- Web UI or TUI dashboard (addable in v2 as `clawops dashboard` on top of existing commands)
- Multi-instance orchestration / fleet management (Kubernetes HPA, autoscaling) — refer users to the openclaw-rocks operator
- OpenClaw skill/agent authoring (clawops is an ops tool, not a dev tool for OpenClaw skills)
- Windows-native support (WSL2 supported; native Windows is a stretch goal for v1.1)
- Multi-tenant SaaS — clawops is a CLI/server you self-host, not a hosted service

---

## 3. User Personas & Use Cases

### 3.1 Primary Persona — Solo Developer

Running OpenClaw as a personal AI agent on a cloud VM. Wants to provision quickly, SSH in occasionally, tail logs when something breaks, and destroy the instance to save money on weekends. Values low cognitive load and fast iteration.

**Representative quote:** *"I want `clawops up` and `clawops down` and that's basically it. If I have to read three READMEs to deploy this thing, I'll go back to Hetzner."*

### 3.2 Secondary Persona — DevOps / Platform Engineer

Deploying OpenClaw for a team or integrating it into an internal platform. Needs IaC parity, JSON output for Terraform/Pulumi composition, scripting support, and secrets management via cloud KMS. May run multiple named environments (staging, prod). Wants the same tool to be drivable from CI and from agents.

**Representative quote:** *"Show me the resource graph before you change anything. Give me dry-run mode and structured logs. If you make me parse human-formatted output, I will write my own wrapper and curse your name."*

### 3.3 Tertiary Persona — AI Agent (via MCP)

A Claude Code, Cursor, or Clanker session that needs to provision or operate an OpenClaw instance on the user's behalf. Needs typed tool schemas with clear when-to-use guidance, structured outputs, progress notifications for long-running operations, and explicit confirmation flows for destructive actions.

**Representative quote (paraphrased from agent telemetry):** *"I will pick the wrong tool if your descriptions are vague. I will skip elicitation if your `destructiveHint` is not set. I have 40 tool slots and you are competing with the user's other 17 servers."*

### 3.4 Use Case Matrix

| Use Case | Command Flow | Persona |
|---|---|---|
| First-time provisioning | `clawops init` → `clawops up --provider gcp` | Solo dev |
| Check instance health | `clawops status` | All |
| Tail gateway logs | `clawops logs -f` | All |
| Update config remotely | `clawops config set gateway.auth.token $T` | All |
| List running agents | `clawops agents list --json | jq` | DevOps |
| Open Control UI locally | `clawops tunnel` | Solo dev |
| Tear down to save cost | `clawops down --destroy` | Solo dev |
| Deploy to named env | `clawops up --stack prod --provider aws` | DevOps |
| SSH into instance | `clawops ssh` | All |
| Agent-driven deploy | MCP tool `clawops_workflow_deploy_app` | Agent |
| Plan + review + apply | `clawops plan --provider aws > plan.json` → review → `clawops apply plan.json` | DevOps |

---

## 4. Strategic Differentiation

### 4.1 vs. Existing OpenClaw Deployment Tools

| Tool | Coverage | Limitation clawops addresses |
|---|---|---|
| `openclaw onboard` | Local install on existing host | No cloud provisioning |
| `openclaw/openclaw-ansible` | Configure existing Debian/Ubuntu host | No provision/destroy lifecycle |
| ClawHost (`bfzli/clawhost`) | Hetzner only, web UI only | No CLI, single provider |
| clawctl.com (SaaS) | Closed source, opaque infra | Not self-hostable, no CLI |
| `infrahouse/terraform-aws-openclaw` | AWS only, Terraform | Single provider, no day-2 ops |
| `Yash-Kavaiya/openclaw-bedrock-ec2` | AWS+Bedrock only | Tutorial-shaped, no license |
| `schmitthub/openclaw-deploy` | Pulumi components, generic VPS | Library not a CLI, requires writing Pulumi |
| `openclaw-rocks/openclaw-operator` | Kubernetes only | K8s-only, not a CLI |
| Helm charts (Chrisbattarbee, serhanekicii) | Kubernetes only | Same |
| Clanker | NL agent, multi-cloud, incidental OpenClaw support | NL-only, no determinism, no OpenClaw-first |

clawops is the only tool combining: **deterministic CLI + provider abstraction + day-2 ops + MCP server + OpenClaw-first**.

### 4.2 vs. Building Provider-Native (Terraform per cloud)

Terraform modules require: writing per-provider modules, managing state per cloud, no day-2 ops, no agent integration, no unified UX. clawops gives users one CLI surface, one mental model, one config format.

---

## 5. Functional Requirements

### 5.1 Core Lifecycle Commands

- **F1.** `clawops init` — interactive first-run wizard configuring state backend, default provider, auth profile
- **F2.** `clawops up` — provision and deploy; idempotent; supports `--dry-run` and `--no-wait`
- **F3.** `clawops down` — stop gateway; `--destroy` flag tears down infra
- **F4.** `clawops status` — current stack state with `--json` output
- **F5.** `clawops plan` — emit Maker plan to stdout/file without applying
- **F6.** `clawops apply <plan>` — apply a previously-generated Maker plan
- **F7.** `clawops destroy --stack <name>` — full Pulumi `stack.destroy()` with elicitation confirmation

### 5.2 Remote Management Commands

- **F8.** `clawops ssh` — interactive SSH session with auto-resolved connection
- **F9.** `clawops tunnel` — forward gateway port to localhost, optionally open browser
- **F10.** `clawops logs [-f] [--tail N] [--since DURATION]` — stream gateway logs
- **F11.** `clawops config get|set|unset` — remote OpenClaw config CRUD with optional `--restart`
- **F12.** `clawops agents list|restart|logs` — proxy to OpenClaw agents subcommand
- **F13.** `clawops gateway status|restart|update` — gateway daemon control
- **F14.** `clawops backup create|restore` — OpenClaw state snapshots

### 5.3 Stack Management

- **F15.** `clawops stacks list` — enumerate named deployment stacks with `--json`
- **F16.** `clawops stacks delete <name>` — remove a stack (after confirmation)
- **F17.** `--stack <name>` global flag on all commands; defaults from config

### 5.4 MCP Server

- **F18.** `clawops mcp serve` — embedded MCP server over stdio (default) or `--http`
- **F19.** `@clawops/mcp-server` — standalone npm package for production deployment
- **F20.** `clawops mcp install --claude|--cursor|--vscode|--windsurf|--zed` — one-flag client config writers
- **F21.** All CLI commands exposed as MCP tools (under `clawops_cli_*` toolset)
- **F22.** Composite agent workflows exposed as `clawops_workflow_*` tools
- **F23.** `--read-only` and `--no-destructive` flags filter destructive tools at registration

### 5.5 Diagnostics

- **F24.** `clawops doctor` — validate node version, auth credentials, state backend access, SSH key presence, Pulumi engine
- **F25.** `clawops version` — version + build info for support diagnostics

### 5.6 Output Contract

- **F26.** Every mutating command supports `--dry-run`
- **F27.** Every command supports `--json` for machine-readable output
- **F28.** Every command supports `--quiet` for CI/scripting
- **F29.** Exit codes: 0 (success), 1 (operational error), 2 (usage error), 3 (auth error), 4 (state error)

---

## 6. Non-Functional Requirements

### 6.1 Performance

- **N1.** First-time provisioning completes in ≤5 minutes for default instance sizes (small VM, single region)
- **N2.** `clawops status` returns in ≤2 seconds against a healthy instance
- **N3.** `clawops logs -f` first byte latency ≤500ms over typical broadband
- **N4.** MCP tool calls return progress notifications at minimum every 10 seconds for long-running operations

### 6.2 Reliability

- **N5.** Idempotent up/down/apply — re-running produces no diff if no spec change
- **N6.** Drift detection via `clawops refresh` reports actual vs. expected state
- **N7.** All destructive operations require either `--yes`, elicitation confirmation, or a confirmed Maker plan
- **N8.** Cancellation: SIGINT/SIGTERM cleanly aborts in-progress operations within 5 seconds; resources may be partially provisioned but state is consistent

### 6.3 Security

- **N9.** No secrets stored in clawops config files — all credentials referenced from environment, cloud KMS, or system keychain
- **N10.** Generated firewall rules deny by default; SSH and gateway ports require explicit CIDR allowlist
- **N11.** SSH host keys verified; first-connection TOFU recorded in `~/.clawops/known_hosts`
- **N12.** MCP server in HTTP mode binds 127.0.0.1 by default; non-loopback binding requires explicit `--bind` flag with audit warning
- **N13.** All MCP tool calls audit-logged with sanitized args, duration, result, session ID

### 6.4 Compatibility

- **N14.** Node.js 20.x and 22.x supported; Node 24.x best-effort
- **N15.** macOS 13+, Ubuntu 22.04+, Debian 12+, RHEL 9+
- **N16.** Windows via WSL2 only for v1
- **N17.** OpenClaw 2026.4.5+ is the minimum supported gateway version (acknowledging the AWS_PROFILE quirk in 2026.4.5+)

### 6.5 Observability

- **N18.** Structured JSON logs to stderr in all modes
- **N19.** OpenTelemetry trace export optional via `OTEL_EXPORTER_OTLP_ENDPOINT`
- **N20.** Human-readable error messages include remediation steps and a docs URL

---

## 7. Phased Delivery

Working backwards from a usable v1.0. Each milestone is independently shippable and useful.

| Phase | Name | Key Deliverables | Target |
|---|---|---|---|
| **M0** ✅ | Skeleton | Repo scaffold, citty wiring, output module (human + JSON), `doctor` (local checks), `--version`, CI green | Week 1 |
| **M1** ✅ | GCP MVP | Pulumi workspace module, GCP adapter (VM + firewall + static IP), `init`/`up`/`down`/`status`/`ssh`/`logs` (GCP only) | Week 3 |
| **M2** ✅ | Remote Mgmt | SSH transport module, `tunnel`, `config get/set/unset`, `agents list/restart`, `gateway status/restart/update` | Week 5 |
| **M3** | AWS + Azure | AWS adapter (EC2 + SG + Elastic IP + SSM), Azure adapter (VM + NSG + Key Vault + Managed Identity), `stacks list/delete`, multi-stack via `--stack` | Week 8 |
| **M4** | Local VM | Local adapter (SSH bootstrap, no Pulumi), `file://` state backend, `init --provider local --host <ip>`, `backup create/restore` | Week 10 |
| **M5** | MCP Layer | `clawops mcp serve` (stdio), all CLI tools as MCP tools, `--read-only` mode, elicitation for destructive, `mcp install --claude/--cursor/...` | Week 12 |
| **M6** | Plan/Apply | `plan` and `apply` commands, deploy-plan schema, Maker flow integration | Week 14 |
| **M7** | v1.0 Polish | `clawops doctor` full surface, `--dry-run` for all mutating commands, CI integration guide, npm publish with provenance, README + docs site | Week 16 |

**Post-v1 candidates (v1.1+):** TUI dashboard, Kubernetes adapter (EKS/GKE/AKS via openclaw-rocks operator), fleet management across stacks, OpenClaw version upgrade orchestration, Homebrew tap.

---

## 8. Success Metrics

- **Adoption:** 500+ npm weekly downloads within 90 days of v1.0
- **Engagement:** GitHub stars trajectory comparable to Clanker's first 90 days (~80–100 stars by month 3)
- **Quality:** <5% of installs hit a `clawops doctor` failure on first run
- **Time-to-value:** New user from `npm install` to running gateway in ≤10 minutes for the GCP happy path
- **Agent integration:** at least one external project (Clanker or other) wires clawops's MCP server into their agent flow within 6 months

---

## 9. Open Questions & Decision Log

| # | Question | Status |
|---|---|---|
| Q1 | CLI framework: `commander` vs. `oclif` vs. `citty` | **Decided: `citty`** (lightweight, native ESM, used by Nuxt; plugin ecosystem not needed for v1) |
| Q2 | SSH key management: generate per-stack vs. user-supplied | **Decided: auto-generate by default**, `--key-path` override flag |
| Q3 | Pulumi bundle size (~50MB): acceptable for npm install? | **Decided: accept for v1**; revisit if user feedback warrants lazy-load |
| Q4 | OpenClaw install method on VM: npm global vs. Docker | **Decided: Docker by default** (aligns with official guides); npm flag for local adapter |
| Q5 | Scoped vs. unscoped npm package | **Decided: unscoped `clawops` for CLI**, scoped `@clawops/mcp-server` for MCP package |
| Q6 | Should clawops vendor schmitthub Pulumi components or use as a peer dep? | **Pending license verification** — see ADR 0002 |
| Q7 | Node 20 vs. 22 minimum | **Decided: Node 20.x minimum** (Node 18 EOL April 2025; Node 20 has stable Web Crypto for MCP auth paths) |
| Q8 | Plan format: JSON Schema or TypeScript types as ground truth | **Decided: JSON Schema as ground truth**, TS types generated; see DESIGN_RULES R-meta |

---

## 10. References

- DESIGN_RULES.md — normative implementation rules
- SPEC.md — technical specification
- docs/architecture.md — narrative architecture
- docs/decisions/ — ADRs
- spec/ — machine-readable schemas
