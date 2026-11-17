# ADR 0017, Hosts hand each other tasks: identity, capabilities, leases

**Status:** Proposed. Four decisions are open (D1–D4); each has a recommendation
**Date:** 2026-11-17
**Deciders:** Project owner
**Revisit:** after the SP-18 spike, and again before P7 writes code

## Context

The [roadmap](../roadmap.md)'s P2 is this ADR and a spike. P7 (3.0) builds co-working: in e2e on
Headscale, host A hands a task to host B, B runs it only in the sandbox (P4), the result returns,
and both hosts audit it. An untagged peer, or a host without the sandbox, is refused. P5 (2.8)
adds the config fields for roles and named agents, and "a schema field is a promise", so this ADR
fixes the model those fields follow before P5 writes any of them.

Three earlier decisions constrain it:

- **[ADR 0014](0014-host-agent-operator-handoff.md): the operator runs every change.** A host agent
  never runs a destructive operation. It hands the operator the command, and the operator runs it
  from their own machine.
- **The host agent is operator-only** ([disclosure review](../security/host-agent-disclosure-review.md)).
  `agent install` refuses unless the agent it serves is dedicated, bound only to the operator, and
  has no agent-to-agent reach. The read set stays complete *because* only the operator reaches
  it.
- **[ADR 0015](0015-host-agent-fleet.md): peers only read.** A peer is a host agent the operator
  named. It is authenticated per request by tailnet tag via `whois`, never by a shared key, and
  its set of tools is the read set.

A handed-off task breaks all three if it is built the obvious way: as a tool call from A's agent
to B's host agent. That call would be a change, made by an agent that is not the operator,
through the one channel the disclosure review requires to be operator-only. So the design
question is where a task runs, not how it travels.

## Decision

### 1. A task is not a tool call, and the host agent does not run it

A task handed to B runs as a turn of a **worker agent** on B's gateway, inside the sandbox (P4),
with no clawops tools and no clawops token. B's host agent only carries the task, the way it
already carries reads, and records it.

This keeps ADR 0014 and the disclosure review true as written:

- **The operator still runs every change to infrastructure.** A task can change nothing outside
  its sandbox, so it is not a change in ADR 0014's sense. If a task needs a change, the worker's
  answer says so, and the change goes to the operator as a handoff, as it does now.
- **The host agent's own agent stays operator-only.** The worker is a different named agent
  (WO-54) with no binding to the operator's channel. `agent install` already refuses a host
  agent whose agent has agent-to-agent reach. The worker has that reach, and the host agent's
  agent still does not.
- **ADR 0015 is amended in one place:** a peer may send *tasks* as well as reads, over the same
  listener, under the same per-request `whois` check. It still cannot call anything destructive.

### 2. Transport

Tasks travel over the peer listener of ADR 0015 (port 18800, `clawops-peer`, the nftables table).
They are a separate set of methods on that listener, not MCP tools in the catalog, which stays at
the R1 cap of 30. A's agent hands a task off through one composite tool (D4).

### 3. Each side audits it

Each task gets an id chosen by the sender. Both hosts write its offer, acceptance, lease renewals,
result and expiry to their audit logs, with the caller fields of ADR 0015 §7. Those records leave
the host over OTLP ([ADR 0016](0016-off-host-audit-otlp.md)), which P3 ships before any of this.

## Open decisions

### D1. Agent identity: what names "who" in the fleet

| Option | What is authenticated | Cost |
|---|---|---|
| **a. The host only** | A task comes from "host A", identified by its StableID and tag | Simplest. Cannot tell two agents on one gateway apart |
| **b. Host, then agent (recommended)** | `<stack>/<agent>`, where the stack part is authenticated by `whois` and the agent name is **asserted by that host** | One more field. The name is only as trustworthy as host A, which already holds every agent on it |
| c. Per-agent tailnet identity | Each agent gets its own node or tag | A tailnet node per agent; the sandbox would need tailnet access, which P4's `network=none` forbids |

**Recommendation: b.** Policy can name agents, and records can say which agent asked, while the
boundary is still what ADR 0015 already proves. ADR 0015 already records that a peer's name is the
peer's own choice and its StableID and tags are not; this extends that to agent names.

### D2. Capability advertisement: how A learns what B will do

| Option | Source of truth | Risk |
|---|---|---|
| **a. Operator-declared, served read-only (recommended)** | The roles declared for B's worker in B's plan (P5). Peers read them through the existing listener, and `fleet status` shows them | Changes need a redeploy of B |
| b. Self-reported by B's gateway | Whatever B's agents say they can do | An injected B can advertise anything |
| c. Encoded as tailnet tags | `tag:clawops-cap-<role>`, granted in the tailnet policy, read by `whois` | Strongest, since only the tailnet admin grants tags. But one tag per capability, and tags are coarse |

**Recommendation: a, with c as the gate for the riskiest capability.** Roles come from B's plan,
and B refuses any task outside them. A tag stays the gate for *accepting tasks at all*
(`tag:clawops-worker`), so a host is never made a worker by a config value alone.

### D3. Lease and handoff semantics

**Recommended:** B holds the lease, and A polls.

- A **offers** a task: an id, a role, its input, and a deadline. B **accepts** it, which starts a
  lease with a TTL, or refuses it with a reason (unknown role, no sandbox, at capacity, the
  sender is not allowed).
- B renews the lease while the worker runs. A reads the status and the result through the
  listener, as it reads anything else, and B never connects back to A. A host that queries no
  peers then still needs no inbound rule.
- **At most once per id.** B refuses an id it has already seen. If a lease expires, the task is
  over, and A may offer it again under a new id. Retries are A's decision, and the audit trail
  shows each attempt.
- **Results are data, not instructions.** A's agent receives the result as a tool result, marked
  as coming from a peer. It never treats it as an operator message.

The alternative, the operator approving each task, keeps ADR 0014's rule literally, but then it
is not co-working, so it is the fallback mode (D3-alt) rather than the default.

**Decision needed:** confirm B-held leases, and whether at-most-once is right, or whether you want
at-least-once with an idempotency key.

### D4. Consent: who allows A to hand B a task

| Option | Where consent lives |
|---|---|
| **a. Standing grant by the operator (recommended)** | B's `agent install --accept-tasks-from <stack>=<roles>`, in the same form as `--peer`. It is CLI-only and `NO_TOOL`, like the rest of `agent install` |
| b. Per-task approval by the operator | Each offer waits in the operator's `status`, like a handoff. Safe, but slow |
| c. B's worker decides | A model's judgment as the boundary. Rejected |

**Recommendation: a**, with b as a per-role option for roles the operator wants to see each time.

The composite tool A's agent uses to hand off (§2) has to fit the R1 cap. **Decision needed:**
retire or merge an existing tool to make room, or extend an existing one, such as
`clawops_stacks_list`'s fleet mode, which 2.5 used to keep `fleet status` within the cap.

## Spike: SP-18, one handoff on two Headscale hosts

On the fleet e2e harness (two systemd targets, Headscale, the nftables table), before P5:

1. A offers a no-op task to B over the peer listener, with D1's `<stack>/<agent>` and a role.
2. B checks the tag, the grant (D4) and the role (D2), accepts, and holds a lease (D3).
3. B's worker runs the task in a sandbox with `network=none`, or a stub of one until P4, and B
   returns the result.
4. Both audit logs carry the matching offer, acceptance, renewal and result records.
5. The refusals: an untagged node, a role B was not granted, a reused id, and an expired lease.

Its assertions land as tests in P7.

## Consequences

**Positive:**
- ADR 0014's rule and the disclosure review stay true as written. Co-working is added beside the
  host agent, not through it.
- The catalog stays at 30 (except for D4's one composite tool, whose slot is still open).
- Every boundary is one that is already proven: `whois` and tags, the nftables table, the sandbox.

**Negative:**
- It depends on P4: until the sandbox ships, there is nothing a peer's task can safely run in.
- A named worker agent per host is new operator-facing configuration (P5).
- An agent name is only as trustworthy as the host that asserts it (D1 b).

**Neutral:**
- 3.0 is a major release because peers stop being read-only. The roadmap's P8 already says so.

## Alternatives Considered

### Alternative A: tasks as destructive tool calls, approved by the operator
- Pro: no new concepts. It is ADR 0014's handoff with a peer as the requester.
- Con: every task waits for a human, and the requester is another agent on a channel the
  disclosure review requires to be operator-only.
- Why not chosen: this is the per-task approval of D4 b, and it does not deliver co-working. It is
  kept as a per-role option.

### Alternative B: a shared queue (Redis, NATS) on the tailnet
- Pro: leases, retries and fan-out come ready-made.
- Con: a third party that every host holds a credential to, which is exactly what ADR 0015 ruled
  out ("no host holds another host's key"). The queue becomes the fleet's keyholder.
- Why not chosen: the peer listener with `whois` already authenticates without a shared secret.

### Alternative C: OpenClaw's own agent-to-agent channels across gateways
- Pro: native to the gateway.
- Con: it gives one agent reach to another agent's channel, which the operator-only binding refuses,
  and it bypasses tags, the firewall table and the audit.
- Why not chosen: it would undo the disclosure review's condition. This should be checked again
  if OpenClaw adds an authenticated cross-gateway transport.

## Verification

- SP-18's five assertions, then the P7 e2e: the handoff, sandbox-only execution, the result
  returned, both audits, and both refusals the roadmap names.
- `agent install` still refuses an operator-bound agent with agent-to-agent reach, and the worker
  is not that agent (unit tests on the guardrail).
- The tool count is checked against R1 in `tests/mcp/parity.test.ts`.

## References

- [ADR 0014](0014-host-agent-operator-handoff.md), [ADR 0015](0015-host-agent-fleet.md),
  [ADR 0016](0016-off-host-audit-otlp.md)
- [Host-agent disclosure review](../security/host-agent-disclosure-review.md)
- [Roadmap: Path to 3.0](../roadmap.md#path-to-30), P2, P4, P5, P7, P8
- [Threat model](../security/threat-model.md) T11
