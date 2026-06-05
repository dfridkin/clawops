# Public Roadmap

This document tracks the public roadmap for clawops. Development milestones (M0–M8) cover the
core implementation; adoption milestones (R1–R12) cover documentation, safety, operational
maturity, and hardening.

**Current state (v1.5.0, published):** all development milestones and adoption waves R1–R11 are
complete. Remaining work is grouped into three release waves: v1.6 (bug reporting + quality),
v1.7 (hardening MVP: core + local/VPS + AWS), v1.8 (hardening complete: GCP + Azure + Tailscale).

## Development milestones

All core development milestones are complete as of v1.0.

| Milestone | Status | Summary |
|---|---|---|
| M0 — Scaffold | ✅ | Tooling, CI, generated types, stubs |
| M1 — GCP MVP | ✅ | `init` / `up` / `down` / `status` / `ssh` / `logs` on GCP |
| M2 — Remote Mgmt | ✅ | `tunnel`, `config`, `agents`, `gateway`; SSH connection pool |
| M3 — AWS + Azure | ✅ | AWS EC2 + Azure VM adapters; `stacks list` |
| M4 — Local VM | ✅ | Local adapter (SSH bootstrap, no Pulumi); `doctor` |
| M5 — MCP Layer | ✅ | `mcp serve` (stdio + HTTP), all CLI ops as MCP tools |
| M6 — Plan/Apply | ✅ | `plan` + `apply`; deploy-plan schema; `workflow_deploy_app` |
| M7 — v1.0 Polish | ✅ | Full `doctor`; `destroy`; `--dry-run` across commands; CI guide |
| M8 — Test Coverage | ✅ | 539 tests; SSH integration harness; e2e mock suite |

## Adoption milestones

These milestones track documentation, security model, operational maturity, and hardening work.
R1–R11 are complete. R12–R13 are in progress, grouped into release waves below.

### Wave status at a glance

| Wave | Milestone | Status | Summary |
|---|---|---|---|
| 1–8 | R1–R8 | ✅ | Docs, security model, operations, launch |
| 9 | R9 | ✅ | Secret lifecycle CLI (`clawops secret`) |
| 10 | R10 | ✅ | Stack monitoring dashboard + MCP tool |
| 11 | R11 | ✅ | Gateway-agent MCP wiring (`clawops mcp wire`) |
| 12 | R12 | ⏳ | Server hardening + Tailscale VPN (`clawops harden`) |
| 13 | R13 | ⏳ | Integrated bug reporting (`clawops bug`) |

### Release groupings for remaining work

Remaining WOs are batched into three releases to avoid a changeset per PR.

| Release | WOs | Theme |
|---|---|---|
| **v1.6** | WO-35, WO-18, M8 stubs | Bug reporting command, local e2e harness, internal stub implementations |
| **v1.7** | WO-29, WO-33, WO-30 | Hardening MVP — core framework + local/VPS + AWS |
| **v1.8** | WO-31, WO-32, WO-34 | Hardening complete — GCP + Azure + Tailscale VPN |

### R1 — First-Run Experience

Goal: let someone understand, install, deploy, and validate clawops quickly.

| Work order | Status | Deliverable |
|---|---|---|
| WO-01 — README rewrite | ✅ | Clear positioning, local VM quickstart, Claude Code connect |
| WO-02 — Local/VPS quickstart | ✅ | `examples/local-vm.md` |
| WO-03 — Example OpenClaw configs | ✅ | `examples/configs/` with model and channel examples |

### R2 — Plan/Apply Trust Model

Goal: make plan/apply behavior accurate, inspectable, and safe.

| Work order | Status | Deliverable |
|---|---|---|
| WO-04 — Plan/apply semantics | ✅ | `docs/plan-apply.md` |
| WO-05 — Plan summary output | ✅ | Per-resource summary in human + JSON output |
| WO-06 — Apply-time drift warning | ✅ | Warning when state changed since plan (design-first) |

### R3 — Security and MCP Safety

Goal: give users a clear safety model for clawops as privileged tooling and MCP server.

| Work order | Status | Deliverable |
|---|---|---|
| WO-07 — MCP safety docs + risk matrix | ✅ | `docs/security/mcp-safety.md`, `docs/security/tool-risk-matrix.md` |
| WO-08 — Read-only / no-destructive docs | ✅ | `docs/mcp/claude-code.md`, `docs/mcp/read-only.md` |
| WO-09 — Audit log + redaction docs | ✅ | `docs/security/audit-logs.md`, `docs/security/redaction.md` |

### R4 — Production Operations

Goal: make single-node deployments credible for ongoing use.

| Work order | Status | Deliverable |
|---|---|---|
| WO-10 — Operations guide | ✅ | `docs/operations.md` |
| WO-11 — Backup/restore validation | ✅ | `docs/backup-restore.md` |
| WO-12 — Health check expansion | ✅ | Deeper status checks beyond "container running" |
| WO-13 — Upgrade/rollback design | ✅ | `docs/upgrade-rollback.md` |

### R5 — Configuration and Secrets

Goal: make real OpenClaw configuration safe, inspectable, and less confusing.

| Work order | Status | Deliverable |
|---|---|---|
| WO-14 — Config validation | ✅ | `clawops config validate` command |
| WO-15 — Secret redaction audit | ✅ | Centralized redaction utility + tests |
| WO-16 — Config wizard design + implementation | ✅ | `clawops setup` — interactive first-run wizard |

### R6 — Provider Reliability

Goal: show which provider paths are supported and prove the most important ones.

| Work order | Status | Deliverable |
|---|---|---|
| WO-17 — Provider capability matrix | ✅ | `docs/providers/matrix.md` |
| WO-18 — Local VM e2e test harness | ⏳ | `tests/e2e/local/` |
| WO-19 — Provider troubleshooting docs | ✅ | Per-provider troubleshooting guides |

### R7 — Developer Experience

Goal: make external contribution safer and easier.

| Work order | Status | Deliverable |
|---|---|---|
| WO-20 — Contributor workflow docs | ✅ | Improved `CONTRIBUTING.md` |
| WO-21 — Generated spec workflow docs | ✅ | `docs/generated-files.md` |

### R8 — Adoption and Launch

Goal: make the repository easy to evaluate, share, and launch.

| Work order | Status | Deliverable |
|---|---|---|
| WO-22 — Public roadmap + limitations | ✅ | `docs/roadmap.md`, `docs/limitations.md` |
| WO-23 — Demo script | ✅ | `docs/demo-script.md` |
| WO-24 — Launch issue set | ✅ | `.github/ISSUE_TEMPLATE/` + seeded issues |

### R9 — Secret Lifecycle Management

Goal: give operators a first-class CLI for creating, rotating, and auditing secrets.

| Work order | Status | Deliverable |
|---|---|---|
| WO-25 — Secret lifecycle CLI | ✅ | `clawops secret list/set/delete/rotate/audit`; `docs/secrets.md` |

### R10 — Stack Monitoring

Goal: live terminal dashboard and MCP tool for continuous stack health visibility.

| Work order | Status | Deliverable |
|---|---|---|
| WO-26 — `clawops monitor` interactive dashboard | ✅ | Refreshing ANSI dashboard: gateway health, sessions, model usage, log tail |
| WO-27 — `clawops_monitor` MCP tool | ✅ | Structured JSON health snapshot for agents |

### R11 — Gateway-Agent MCP Wiring

Goal: let the OpenClaw gateway's own AI agent invoke clawops management commands via MCP.

| Work order | Status | Deliverable |
|---|---|---|
| WO-28 — Gateway-agent MCP client config | ✅ | `clawops mcp wire` command; optional wizard step |

### R12 — Server Hardening

Goal: reduce attack surface and optionally route all traffic through a private Tailscale network, with provider-specific hardening steps and a multi-select wizard step during setup.

| Work order | Status | Deliverable |
|---|---|---|
| WO-29 — `clawops harden` command + wizard integration | ⏳ | Core hardening command, shared module framework, multi-select wizard step |
| WO-30 — AWS hardening | ⏳ | VPC Flow Logs, GuardDuty opt-in, Security Group audit, Session Manager check |
| WO-31 — GCP hardening | ⏳ | Shielded VM check, VPC firewall audit, OS Login opt-in |
| WO-32 — Azure hardening | ⏳ | JIT VM Access, Defender for Cloud, NSG audit, disk encryption check |
| WO-33 — Local/VPS hardening | ⏳ | SSH hardening, UFW, fail2ban, unattended-upgrades, CIS Level 1 report |
| WO-34 — Tailscale VPN integration | ⏳ | Install Tailscale, join network, update SSH/gateway config, optional private-only mode |

### R13 — Integrated Bug Reporting

Goal: let users report bugs without leaving the terminal, with system context pre-filled.

| Work order | Status | Deliverable |
|---|---|---|
| WO-35 — `clawops bug` command | ⏳ | Doctor context + pre-filled GitHub issue URL + browser open |

## What is not on the roadmap

The following are explicitly out of scope for the current roadmap. They may be revisited in a
future major version:

- High-availability or multi-node deployments
- Kubernetes provider
- OpenClaw skill/agent authoring
- Scheduled / trigger-based secret rotation (manual rotation via `clawops secret rotate` is supported; automatic scheduling is not)
- Native Windows support (WSL2 is supported)
- Fleet management across many stacks
- Multi-region or active-active topologies per stack

## How to contribute

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the contribution guide. Work orders with ⏳ status
are open for contribution. Good first issues are labeled accordingly on GitHub.

To propose a new roadmap item, open a GitHub issue with the `roadmap` label.
