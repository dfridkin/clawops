# Public Roadmap

This document tracks the public roadmap for clawops. Development milestones (M0–M8) cover the
core implementation; adoption milestones (R1–R12) cover documentation, safety, operational
maturity, and hardening. The path to 3.0 (P1–P10) orders what comes next.

**Current state (2.4.1):** all development milestones are complete, and adoption waves
R1–R13 have shipped. Bug reporting (`clawops bug`) and the hardening MVP landed in the 1.7 line.
2.0 moved clawops onto OpenClaw 2.x; 2.0.1 and 2.0.2 made cloud deploys work on all three clouds.
2.1 added Tailscale private networking and hardening on every cloud. 2.2 made recovery a flag
(`clawops backup restore --activate`), gave every command an agent needs an MCP tool, and made SSH
failures say what failed. 2.3 added spending limits the operator sets and no tool can lift; 2.3.1 stops `config_set` values reaching the audit log in clear. 2.4 adds the host agent (WO-62): clawops on the gateway host, for one agent only the operator can reach, which reads its own host and hands every change back to the operator as a command.

Remaining work falls into three groups:

| Group | Items | Notes |
|---|---|---|
| **Carried from the 1.x waves** | WO-34 (Tailscale), partly | Azure hardening landed in WO-32. Tailscale joins, repoints, goes private-only and reverts; the doctor check is still open |
| **2.x backlog** | WO-53 sandboxing, WO-54 config surface, WO-55 TLS and public origin, WO-56 observability, WO-57 fleet multi-tenancy | Planned for 2.1 and not in it; 2.1 shipped private networking and hardening instead. WO-55 gates Portals, Teams, Slack and Discord Activities. Now scheduled in [Path to 3.0](#path-to-30) |
| **clawops 2.3** | Spending limits (WO-62 precondition 1, in part), backlog fixes | Operator-set instance-type allowlist and stack cap, enforced on every surface |
| **clawops 2.4: alone** | WO-62 host agent | ✅ shipped by itself, behind its preconditions (see below and [ADR 0014](decisions/0014-host-agent-operator-handoff.md)). It was 2.2, then 2.3, as other work shipped first |
| **clawops 2.5 (planned)** | Host-agent fleet ([ADR 0015](decisions/0015-host-agent-fleet.md), accepted 2026-10-18) | Host agents that each manage only themselves and read each other over the tailnet, authenticated by tag, with no shared keys. Verified by SP-14–SP-16, including real Tailscale and a real-VM reboot. Built as [WO-67](fleet-plan.md): parts A (membership and the firewall table), B (`clawops fleet status`), C (the peer listener), D (peer queries) and E (the Headscale e2e suite, `doctor`'s policy check, docs) done ✅. Not WO-57, which is tenants on one host. Sandboxing other agents gets its own ADR with WO-53 |
| **Housekeeping** | WO-64 `server.json` drift | ✅ shipped. Bumped at version time, with a test that it agrees with `package.json` |

### WO-62 ships on its own, and only after its preconditions

Running clawops *on* the gateway host is not a feature with risks attached. It is a change of
security posture delivered as a feature, and **every mitigation clawops has assumes a human is
the operator**. Plans get reviewed, destructive tools ask for confirmation, `--read-only` is an
operator's choice. Put the agent in the operator's chair and each becomes a formality the agent
performs on itself.

Four failure modes drive the decision to ship it alone:

- **Runaway spend.** There is no cost estimation, no budget guard, no instance-size ceiling and
  no cap on stacks. A retry loop around a failing deploy is enough; malice is not required, and
  billing alerts lag by hours.
- **Injection reaching destructive tools.** Every channel message is untrusted input, and the
  gateway MCP server runs without `--read-only` by WO-28's design note. Confirmation is a control
  over a human's attention, not over an agent's.
- **Self-destruction, complete.** The process performing a `destroy` runs on the instance being
  destroyed, so it dies partway through finalising state, leaving a state file that disagrees
  with reality, possibly locked by a process that no longer exists.
- **Self-destruction, incomplete.** Likelier and worse: orphaned resources keep billing, and the
  operator who would clean them up was the agent. Recovery needs an out-of-band human who, in an
  unattended deployment, may not exist.

The preconditions. An enforced spend ceiling, a self-targeting guard below the tool layer, a
narrow cloud identity for the host, state it cannot delete, audit shipped off-host, a documented
break-glass operator, and default `--read-only`, are listed in full in
[`openclaw-2.0-migration-plan.md`](openclaw-2.0-migration-plan.md). Several are worth building on
their own merits.

**Re-aligned after 2.2.** 2.2 grew the destructive tool surface from 8 to 13 and filled the
catalog to its 30-tool cap, and since 2.1.3 an agent can approve a destructive call itself by
passing `yes: true`. So the self-targeting guard now covers everything that changes the host
clawops runs on, host-agent mode must ignore `yes`, and two preconditions are added: a disclosure
review of the read toolset, and a tool budget. A two-phase delivery, local-provider hosts first,
was considered and declined: 2.4 ships local and cloud together. A host agent never runs a
destructive operation: it hands the operator the exact command to run from their own machine
(ADR 0014, accepted 2026-10-14). On 2026-10-16 its scope was narrowed: a host agent manages
only the host it runs on, with local tools and no cloud identity. A host agent that manages other
deployments is a fleet design, deferred to ADR 0015 and 2.5. Each precondition is accepted by an e2e test
on the 2.2 harness.
Details are in the plan, under *Re-alignment after 2.2*.

## Path to 3.0

*Proposed 2026-11-05.* The next major target is **3.0: host agents that co-work.** Host agents on separate stacks hand
tasks to each other over the tailnet, run them only in a sandbox, and can use a model on their own
host. 2.5's fleet already gives them reachability; what 3.0 adds is coordination.

The ordering rule: work that co-working depends on goes before 3.0, and work that only widens
channel reach or tenancy goes after it. That schedules every item in the *2.x backlog* row
above, and adds two items that were not on it. Audit that leaves the host (WO-62 precondition 5)
is met in 2.4 because every change runs on the operator's machine ([ADR 0014](decisions/0014-host-agent-operator-handoff.md)
§5); it reopens once a peer's task runs on a host. And a cloud budget with an enforcement action,
the rest of precondition 1, is still unbuilt.

| Milestone | Release | Scope | Done when |
|---|---|---|---|
| **P1** | 2.5 | Host-agent fleet (WO-67), WO-34's doctor check | 2.5.0 is on npm with the three pending changesets; the Headscale e2e suite is green in the e2e workflow on the release commit; WO-34 is ✅ |
| **P2** | none | Coordination ADR and spike, alongside P3 and P4 | An ADR is accepted, before P5 fixes any field, on agent identity, capability advertisement, task lease and handoff. It amends ADR 0015, whose peers only read each other, and says how a peer's task fits ADR 0014's rule that the operator runs every change and the host agent's operator-only binding ([disclosure review](security/host-agent-disclosure-review.md)). A two-host Headscale spike proves one handoff |
| **P3** | 2.6 | WO-56 observability plugins, off-host audit | The gateway's observability plugins are configurable; clawops, host-agent and peer audit records export to an endpoint the operator owns, through a credential on the host that can append but not delete or rewrite; [telemetry](telemetry.md) describes only what is built (OTLP export is not, per [logging](logging.md)) |
| **P4** | 2.7 | WO-53 sandboxing, opt-in | A sandboxing ADR is accepted, as ADR 0015 promises. The gateway, on the unmodified official image, spawns sibling sandboxes with `cap-drop=ALL` and `network=none` from a sandbox image built on the host (SP-04, SP-09). The workspace is intact after a gateway restart, and a test shows the Docker socket mount does not get a sandbox past the fleet firewall table. e2e on local and on one cloud |
| **P5** | 2.8 | WO-54 roles, named agents, credential store, telemetry | Each field ships with the code that reads it, and the roles fields follow P2's capability model; secrets resolve from the credential store, not from `openclaw.json` |
| **P6** | 2.9 | Local inference backend, CPU | `clawops up` provisions `llama-server` bound to the Docker bridge only, with weights cached across reboots; the gateway points at it and `doctor` checks it. GPU (vLLM) comes later: it needs drivers and the container toolkit on each provider |
| **P7** | 3.0 | Co-working | Merged to `main`: in e2e on Headscale, host A hands a task to host B, B runs it only in the sandbox, the result returns, and both hosts audit it; an untagged peer, or a host without the sandbox, is refused |
| **P8** | 3.0 | Budgets, safety pass, release | A cloud budget with an enforcement action exists and `up` checks it, finishing precondition 1; in the P7 e2e, a handed-off task that exceeds its model-token budget stops; no peer can trigger a deploy; the tool count stays within the R1 cap; the threat model and tool-risk matrix are updated. 3.0.0 ships with a migration note: a major, because peers stop being read-only |
| **P9** | 3.1 | WO-55 TLS and public origin | On AWS, GCP and Azure a stack serves the gateway on a public origin with TLS. The gateway stays on loopback behind a terminator on the host, and `harden` opens 443 only when TLS is enabled ([limitations](limitations.md#networking-and-tls)). This unblocks Portals, Teams, Slack and Discord Activities |
| **P10** | 3.2 | WO-57 fleet multi-tenancy | `up` deploys tenant cells with the containerised `openclaw fleet` (SP-05's flags) on a pinned tag, not `:latest`; plan validation rejects tenant cells and sandboxing on the same host (§8.2 of the 2.0 plan) |

**Why each item sits where it does:**

- **Coordination is designed first and built late.** Its ADR runs alongside P3 and P4 and is
  accepted before P5, because roles are what a peer advertises and a schema field is a promise.
  It has to amend ADR 0015 before P7 writes code.
- **Observability and off-host audit come next** because they are small and every later
  milestone needs a record that outlives the host. A sandboxed task or a peer handoff that can
  erase its own trail is not reviewable.
- **Sandboxing comes before anything a peer can ask for.** A handed-off task is untrusted input
  that runs code.
- **The config surface follows the ADR.** It gives the capability model its fields, and the
  credential store keeps raw keys out of anything handed off.
- **Local inference is small and independent, on CPU.** An Ollama the operator runs already
  works through `host.docker.internal` (see [limitations](limitations.md)); this milestone is
  clawops provisioning one.
- **WO-55 waits until after 3.0.** It is the largest item, the tailnet already carries fleet
  traffic, and nothing before 3.0 needs it. Pulling it forward because it is the most visible
  item would delay everything co-working depends on.
- **WO-57 goes last.** Tenants on one host cannot share that host with sandboxing, so tenant
  hosts cannot co-work, and nothing on the 3.0 path needs them.

## Development milestones

All core development milestones are complete as of v1.0.

| Milestone | Status | Summary |
|---|---|---|
| M0: Scaffold | ✅ | Tooling, CI, generated types, stubs |
| M1: GCP MVP | ✅ | `init` / `up` / `down` / `status` / `ssh` / `logs` on GCP |
| M2: Remote Mgmt | ✅ | `tunnel`, `config`, `agents`, `gateway`; SSH connection pool |
| M3: AWS + Azure | ✅ | AWS EC2 + Azure VM adapters; `stacks list` |
| M4: Local VM | ✅ | Local adapter (SSH bootstrap, no Pulumi); `doctor` |
| M5: MCP Layer | ✅ | `mcp serve` (stdio + HTTP), all CLI ops as MCP tools |
| M6: Plan/Apply | ✅ | `plan` + `apply`; deploy-plan schema; `workflow_deploy_app` |
| M7: v1.0 Polish | ✅ | Full `doctor`; `destroy`; `--dry-run` across commands; CI guide |
| M8: Test Coverage | ✅ | 539 tests; SSH integration harness; e2e mock suite |

## Adoption milestones

These milestones track documentation, security model, operational maturity, and hardening work.
R1–R13 are complete. What remains from these waves is GCP and Azure hardening and the
Tailscale integration.

### Wave status at a glance

| Wave | Milestone | Status | Summary |
|---|---|---|---|
| 1–8 | R1–R8 | ✅ | Docs, security model, operations, launch |
| 9 | R9 | ✅ | Secret lifecycle CLI (`clawops secret`) |
| 10 | R10 | ✅ | Stack monitoring dashboard + MCP tool |
| 11 | R11 | ✅ | Gateway-agent MCP wiring (`clawops mcp wire`) |
| 12 | R12 | ✅ | Server hardening (`clawops harden`), GCP, Azure and Tailscale modules still open |
| 13 | R13 | ✅ | Integrated bug reporting (`clawops bug`) |

### Release groupings for remaining work

Remaining WOs are batched into three releases to avoid a changeset per PR.

| Release | WOs | Status |
|---|---|---|
| **v1.6** | WO-35, WO-18, M8 stubs | ✅ shipped |
| **v1.7** | WO-29, WO-33, WO-30 | ✅ shipped: hardening MVP, core + local/VPS + AWS |
| **v1.8** | WO-31, WO-32, WO-34 | GCP and Azure hardening shipped. Tailscale joins, repoints, goes private-only and reverts; the doctor check moves to P1 in [Path to 3.0](#path-to-30) |

### R1. First-Run Experience

Goal: let someone understand, install, deploy, and validate clawops quickly.

| Work order | Status | Deliverable |
|---|---|---|
| WO-01: README rewrite | ✅ | Clear positioning, local VM quickstart, Claude Code connect |
| WO-02: Local/VPS quickstart | ✅ | `examples/local-vm.md` |
| WO-03: Example OpenClaw configs | ✅ | `examples/configs/` with model and channel examples |

### R2. Plan/Apply Trust Model

Goal: make plan/apply behavior accurate, inspectable, and safe.

| Work order | Status | Deliverable |
|---|---|---|
| WO-04: Plan/apply semantics | ✅ | `docs/plan-apply.md` |
| WO-05: Plan summary output | ✅ | Per-resource summary in human + JSON output |
| WO-06: Apply-time drift warning | ✅ | Warning when state changed since plan (design-first) |

### R3. Security and MCP Safety

Goal: give users a clear safety model for clawops as privileged tooling and MCP server.

| Work order | Status | Deliverable |
|---|---|---|
| WO-07: MCP safety docs + risk matrix | ✅ | `docs/security/mcp-safety.md`, `docs/security/tool-risk-matrix.md` |
| WO-08: Read-only / no-destructive docs | ✅ | `docs/mcp/claude-code.md`, `docs/mcp/read-only.md` |
| WO-09: Audit log + redaction docs | ✅ | `docs/security/audit-logs.md`, `docs/security/redaction.md` |

### R4. Production Operations

Goal: make single-node deployments credible for ongoing use.

| Work order | Status | Deliverable |
|---|---|---|
| WO-10: Operations guide | ✅ | `docs/operations.md` |
| WO-11: Backup/restore validation | ✅ | `docs/backup-restore.md` |
| WO-12: Health check expansion | ✅ | Deeper status checks beyond "container running" |
| WO-13: Upgrade/rollback design | ✅ | `docs/upgrade-rollback.md` |

### R5. Configuration and Secrets

Goal: make real OpenClaw configuration safe, inspectable, and less confusing.

| Work order | Status | Deliverable |
|---|---|---|
| WO-14: Config validation | ✅ | `clawops config validate` command |
| WO-15: Secret redaction audit | ✅ | Centralized redaction utility + tests |
| WO-16: Config wizard design + implementation | ✅ | `clawops setup`: interactive first-run wizard |

### R6. Provider Reliability

Goal: show which provider paths are supported and prove the most important ones.

| Work order | Status | Deliverable |
|---|---|---|
| WO-17: Provider capability matrix | ✅ | `docs/providers/matrix.md` |
| WO-18: Local VM e2e test harness | ✅ | `tests/e2e/` |
| WO-19: Provider troubleshooting docs | ✅ | Per-provider troubleshooting guides |

### R7. Developer Experience

Goal: make external contribution safer and easier.

| Work order | Status | Deliverable |
|---|---|---|
| WO-20: Contributor workflow docs | ✅ | Improved `CONTRIBUTING.md` |
| WO-21: Generated spec workflow docs | ✅ | `docs/generated-files.md` |

### R8. Adoption and Launch

Goal: make the repository easy to evaluate, share, and launch.

| Work order | Status | Deliverable |
|---|---|---|
| WO-22: Public roadmap + limitations | ✅ | `docs/roadmap.md`, `docs/limitations.md` |
| WO-23: Demo script | ✅ | `docs/demo-script.md` |
| WO-24: Launch issue set | ✅ | `.github/ISSUE_TEMPLATE/` + seeded issues |

### R9. Secret Lifecycle Management

Goal: give operators a first-class CLI for creating, rotating, and auditing secrets.

| Work order | Status | Deliverable |
|---|---|---|
| WO-25: Secret lifecycle CLI | ✅ | `clawops secret list/set/delete/rotate/audit`; `docs/secrets.md` |

### R10. Stack Monitoring

Goal: live terminal dashboard and MCP tool for continuous stack health visibility.

| Work order | Status | Deliverable |
|---|---|---|
| WO-26: `clawops monitor` interactive dashboard | ✅ | Refreshing ANSI dashboard: gateway health, sessions, model usage, log tail |
| WO-27: `clawops_monitor` MCP tool | ✅ | Structured JSON health snapshot for agents |

### R11. Gateway-Agent MCP Wiring

Goal: let the OpenClaw gateway's own AI agent invoke clawops management commands via MCP.

| Work order | Status | Deliverable |
|---|---|---|
| WO-28: Gateway-agent MCP client config | ⚠️ | `clawops mcp wire` command; optional wizard step. **Shipped non-functional in v1.5**, wrote `gateway.mcpClients`, a key OpenClaw has never had. Corrected in WO-61 (2.0) |

### R12. Server Hardening

Goal: reduce attack surface and optionally route all traffic through a private Tailscale network, with provider-specific hardening steps and a multi-select wizard step during setup.

| Work order | Status | Deliverable |
|---|---|---|
| WO-29: `clawops harden` command + wizard integration | ✅ | Core hardening command, shared module framework, multi-select wizard step |
| WO-30: AWS hardening | ✅ | VPC Flow Logs, GuardDuty opt-in, Security Group audit, Session Manager check |
| WO-31: GCP hardening | ✅ | VPC firewall audit, Shielded VM check, OS Login check. All check-only: see the changeset for why the last two do not apply |
| WO-32: Azure hardening | ✅ | NSG audit, disk encryption, Defender for Cloud, JIT VM Access. All check-only: see the matrix for why each one is |
| WO-33: Local/VPS hardening | ✅ | SSH hardening, UFW, fail2ban, unattended-upgrades, CIS Level 1 report |
| WO-34: Tailscale VPN integration | ◐ | Shipped: install, join, report the address (off-by-default module); `harden --tailscale` repoints clawops at the verified tailnet address; `plan --private-only` closes public ingress (ADR 0013); `harden --tailscale-revert`. Not yet: doctor check |

### R13. Integrated Bug Reporting

Goal: let users report bugs without leaving the terminal, with system context pre-filled.

| Work order | Status | Deliverable |
|---|---|---|
| WO-35: `clawops bug` command | ✅ | Doctor context + pre-filled GitHub issue URL + browser open |

## What is not on the roadmap

The following are explicitly out of scope for the current roadmap. They may be revisited in a
future major version:

- High-availability or multi-node deployments of one gateway (host agents co-working across stacks is [Path to 3.0](#path-to-30))
- Kubernetes provider
- OpenClaw skill/agent authoring
- Scheduled / trigger-based secret rotation (manual rotation via `clawops secret rotate` is supported; automatic scheduling is not)
- Native Windows support (WSL2 is supported)
- Fleet management across many stacks beyond host agents reading and handing work to each other (ADR 0015 and [Path to 3.0](#path-to-30))
- Multi-region or active-active topologies per stack

## How to contribute

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the contribution guide. Work orders with ⏳ status
are open for contribution. Good first issues are labeled accordingly on GitHub.

To propose a new roadmap item, open a GitHub issue with the `roadmap` label.
