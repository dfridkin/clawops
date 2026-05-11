# Public Roadmap

This document tracks the public roadmap for clawops. Development milestones (M0–M8) cover the
core implementation; adoption milestones (R1–R8) cover documentation, safety, and launch
readiness.

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
| M8 — Test Coverage | ✅ | 476 tests; SSH integration harness; e2e mock suite |

## Adoption milestones

These milestones track documentation, security model, and launch-readiness work. They do not
change the core implementation but make clawops easier to understand, evaluate, and trust.

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
| WO-23 — Demo script | ⏳ | `docs/demo-script.md` |
| WO-24 — Launch issue set | ⏳ | GitHub issue templates + seeded issues |

## What is not on the roadmap

The following are explicitly out of scope for the current roadmap. They may be revisited in a
future major version:

- High-availability or multi-node deployments
- Kubernetes provider
- OpenClaw skill/agent authoring
- Automatic secret rotation
- Native Windows support (WSL2 is supported)
- Fleet management across many stacks

## How to contribute

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the contribution guide. The roadmap items above with
⏳ status are all open for contribution. Good first issues are labeled accordingly on GitHub.

To propose a new roadmap item, open a GitHub issue with the `roadmap` label.
