# ADR 0014, Host agent hands destructive work to the operator

**Status:** Accepted
**Date:** 2026-10-05, revised 2026-10-14 and 2026-10-16
**Deciders:** Project owner
**Revisit:** after the first quarter of host agents in use, if handing off proves too slow (see
*Alternatives Considered*, signed approvals)

## Context

WO-62 runs clawops on the gateway host, so the gateway's own AI can operate its deployment. The
plan (`docs/openclaw-2.0-migration-plan.md`, WO-62 and *Re-alignment after 2.2*) and threat T11
explain why that is a change of security posture rather than a feature: every clawops safety
control assumes a human is the operator, and here the operator is a model that reads untrusted
text from every channel the gateway is connected to.

Two facts from 2.2 shape this decision:

- **Confirmation does not constrain an agent.** R19 makes destructive tools ask before they run,
  and says it binds the tool body so "even non-conformant clients can't bypass it". Since 2.1.3,
  a client without elicitation is told to call again with `yes: true`. For a host agent, that
  makes the confirmation the agent's own next call.
- **The catalog is full.** R1 caps it at 30 tools and 2.2 reached 30.

On 2026-10-05 two decisions were made. First, the host-agent release, then labelled 2.3 and now
2.4, ships **local and cloud together**. Second, the operator **approves destructive calls from
their own machine**.

The first draft of this ADR met the second decision with signed approvals. A destructive call
became a pending approval on the host. The operator signed it with their SSH key, and the host
verified the signature and ran the call. Review on 2026-10-14 raised two problems:

- An approval needs a notification, or it expires unseen. Every way of notifying the operator
  either added a service to configure or required integrating with OpenClaw.
- Signing bought little. The operator already needs their machine, their key and SSH access to
  approve. The only difference from running the command themselves was *where* the call ran.

The revision keeps the decision, that the operator approves from their own machine, and makes
the approval the operator running the command.

On 2026-10-16 the scope was narrowed. A host agent could have been given cloud access, to read
Pulumi state and cloud logs, or to manage other deployments in a fleet. Both were set aside for
2.4:

- **Pulumi run output does not live on the host or in the state backend.** It is in
  `~/.clawops/state/<stack>.last-run.json` on the operator's machine. Reading state would need
  the state passphrase (ADR 0011) on the host. clawops has no tool that reads cloud logs today.
- **Cloud-side faults are the ones a host agent cannot see anyway.** If the instance is stopped
  or its network is broken, the agent is down or unreachable with it. What it can see from the
  inside (gateway, container, config, disk, logs) is local.
- **A fleet manager needs every host's SSH key**, which makes one chat-reachable gateway the
  keyholder for the fleet. That is the case T11 describes. A fleet design gets its own ADR
  (0015, planned for 2.5): host agents that each manage only themselves, queried over the
  tailnet, with no shared keys.

"Local and cloud together" therefore means a host agent runs on local and cloud stacks alike,
and on both it manages only the host it runs on.

## Decision

### 1. Host-agent mode is a server mode, not a toolset

`clawops mcp serve --host-agent` runs on the gateway host as its own systemd unit,
`clawops-agent.service`, separate from `openclaw.service`. The operator installs it from their own
machine over the existing SSH transport:

```
clawops agent install --stack <name> [--allow <tool,...>]
```

In host-agent mode:

- **`yes` is ignored by every tool.** It stays in the schema, because removing it would make the
  same tool behave differently by mode. The server reads it, discards it, and says so in the
  result.
- **Elicitation is not consulted.** A confirmation answered by the gateway's client is answered by
  the same agent this mode exists to contain.
- **Tools run on the host itself.** They read the gateway, its container, its config and its
  logs directly, with no SSH and no Pulumi. The stack's name and outputs come from the unit's
  configuration, written by `agent install`. The host agent makes no cloud API calls, and 2.4
  gives it no cloud identity (see §5, precondition 3).
- **The mode fixes the tool set**, and `--toolsets` does not change it. The agent gets:
  - the read toolset as it stands after the disclosure review (precondition 8), complete because
    only the operator can reach the agent
  - the destructive tools the operator named with `--allow`, which hand off (§2)

  By default nothing destructive is listed.

### 2. A destructive call is handed off, not run

A destructive tool that is allowed in host-agent mode changes nothing. It returns the exact CLI
command that performs the same operation, for the operator to run on their own machine:

> Needs the operator. Run on your machine: `clawops gateway restart --stack prod`

The command is built from the tool's arguments by the same mapping the parity test already
checks, so a handoff never names a flag the CLI lacks.

- **The agent tells the operator in its own conversation.** The operator is reached through the
  channel they are already using to talk to the gateway. No service, webhook or OpenClaw
  integration is added.
- **Running the command is the approval.** The operator runs it as an ordinary CLI command, with
  their own credentials. It passes the spending policy and the usual confirmation, as it does
  today.
- **A lie does no harm.** The agent may misreport what the command does, but the command is shown
  in full, and that is what runs. If the agent never passes the message on, nothing happens.
- **Secrets stay out of the chat.** An argument the audit log would redact is replaced in the
  command with a placeholder, which the operator fills in.

The result is an ordinary tool result and returns at once. The agent does not wait, and
`clawops_task_status` gains no states.

### 3. Pending handoffs show where the operator already looks

In case the agent drops the message, each handoff is also appended, redacted, to
`/var/lib/clawops-agent/handoffs.jsonl` on the host.

The operator's clawops reads that file over the SSH connection it already opens for `status`,
`logs` and the other commands that reach the stack. It then prints a banner such as:

> prod has 1 request from its agent: `clawops gateway restart --stack prod`

`clawops_status` reports the same requests, so the operator's own agent sees them too. A request
clears when the operator runs the matching command, or after 7 days.

The agent can write this file, so it can also forge entries. That does no harm: the banner shows
the command, and the operator decides whether to run it.

### 4. The self-targeting guard refuses outright

Some operations end the host or the stack the agent runs on:

- `destroy` of its own stack
- `down` of its own stack
- `stacks_delete` of its own stack
- `migrate` of its own host

In host-agent mode these are refused without a handoff. An agent proposing to remove itself is a
sign of injection, not a maintenance request. The refusal tells the operator these are done from
their machine and does not suggest a command.

Every other allowed destructive tool hands off: `gateway_restart`, `gateway_update`,
`backup_restore` with `activate`, `config_set`, `config_unset` and `harden`.

The guard lives in the server's dispatch, below every tool handler, and is keyed on the stack
named in the host-agent unit's configuration. No tool argument can change it.

### 5. The preconditions

The host never performs a destructive operation, so several preconditions become read-only
problems.

| # | Precondition | How 2.4 meets it |
|---|---|---|
| 1 | Spend ceiling, enforced | **Built in 2.3:** an instance-type allowlist and a stack cap live in the operator's config (`policy`), not in the plan. The host cannot create resources (3), and a handed-off `up` or `apply` runs on the operator's machine under that policy |
| 2 | Self-targeting guard | §4 |
| 3 | Narrow cloud identity | **None is added.** The host agent's tools are local and make no cloud calls, and its unit gets no credentials. The instance's existing identity (Bedrock invoke on AWS, Key Vault secrets on Azure, the compute service account on GCP) is not used by clawops-agent. It stays reachable by any process on the host, which T11 records |
| 4 | State the host cannot delete | Follows from 3: the host holds no state credentials and no passphrase |
| 5 | Audit off-host | Every change is made from the operator's machine and audited there. The host's audit log records reads and handoffs, and `status` pulls the handoffs to the operator's machine (§3) |
| 6 | Break-glass operator | The operator is the only party that can change the stack. `agent install` records who that is and refuses without it, and the docs say what they need and where |
| 7 | Read-only default, `yes` not honoured | §1 |
| 8 | Disclosure review | **Done 2026-10-16** ([review](../security/host-agent-disclosure-review.md)). The host agent is operator-only: `agent install --agent <id> --operator <channel>:<peer>` refuses unless the agent is dedicated and bound only to the operator, with no agent-to-agent reach. The tools stay complete. The read set is 12: `clawops_plan` is left out because planning needs the operator's config and state |
| 9 | Tool budget | No new tools. Host-agent behaviour is a server mode, and `agent install` is CLI-only (§6) |

### 6. CLI-only commands

`clawops agent install` gets no MCP tool. Installing a host agent is the operator choosing what
an agent may do, so it cannot be done by an agent. It goes in `NO_TOOL` in
`tests/mcp/parity.test.ts` and in `docs/limitations.md`, with that reason.

### 7. Acceptance is an e2e test per precondition

The tests run on the 2.2 harness: a systemd target, the built server and an SDK client. A
precondition is done when a test exists that would pass without the precondition and fails with
it. At minimum:

- An allowed destructive call returns a handoff command and changes nothing on the host.
- The same call with `yes: true` returns the same handoff and changes nothing.
- The handoff command, run through the CLI, performs the operation the tool describes.
- A secret argument does not appear in the handoff text or in `handoffs.jsonl`.
- `clawops status` from the operator's side shows a pending handoff and clears it once the
  command is run.
- `destroy` of the agent's own stack is refused with no command offered.
- A tool not allowed at install time is not listed in `tools/list`.
- The host-agent unit's environment holds no cloud or state credentials, and no tool in its
  `tools/list` reaches Pulumi.

## R-meta-3: the rules this bends

**R6, credentials never in tool args.** No longer bent since the 2026-10-16 revision: the host
agent holds no credentials. A fleet or cloud-reading host agent would bend it again, and ADR 0015
must address it.

**R19, elicitation before destruction.**
- *How it is bent:* in host-agent mode a destructive tool neither asks nor runs, and `yes` is
  ignored. That departs from R19's mechanism but strengthens its intent, which is that
  destruction needs a human.
- *Mitigation:* §2 and §4.
- *Revisit:* when MCP gives a server a way to reach a human that does not go through the calling
  client.

## Consequences

**Positive:**
- A model cannot carry out a destructive operation through any argument or any client. It can
  only propose one.
- No new service, webhook, key exchange, network listener or tool. The notification is the
  conversation the agent is already in.
- The host agent holds no cloud identity, which makes preconditions 1, 3 and 4 nearly free.
- Running a handed-off command uses the CLI paths that already exist and are tested.

**Negative:**
- The operator must act from their machine, with their key and SSH access. On a private-only
  stack that means the tailnet. Signed approvals had the same requirement.
- The gateway cannot maintain itself unattended. A restart it needs waits for a human.
- The host agent cannot diagnose faults outside its host, such as a stopped instance or a
  security-group change. Those stay with the operator's clawops.
- Anything with root on the host can still use the instance's existing identity. T11 says so.

**Neutral:**
- The same tool returns a handoff in host-agent mode and acts in every other mode. Tool
  descriptions and `docs/security/mcp-safety.md` say so.

## Alternatives Considered

- **Signed approvals (the first draft of this ADR).** A destructive call is queued on the host.
  The operator signs it with their SSH key from their machine, and the host verifies the
  signature and runs exactly the signed call, once.
  - Why it was set aside: it needs a notification to be usable (see next item) and adds pending
    state, expiry, pinned keys and three task states, while still requiring the operator's
    machine.
  - When to reopen it: if handing off proves too slow in practice. In a new ADR it would pair
    with approvals that are bound to the stack's state rather than to a clock.
- **Push notifications to the operator** (ntfy, Slack or Discord webhooks, email, cloud
  notification services, or OpenClaw's own channels). These were weighed as companions to signed
  approvals. Each adds something for the operator to configure or an integration with OpenClaw.
  The handoff makes them unnecessary, because the agent's conversation already reaches the
  operator.
- **A read-only cloud role for the host** (the 2026-10-14 text). Set aside on 2026-10-16: no
  tool would use it, and it would put a standing identity on the host. It can be added later
  without redesign if cloud-side facts prove necessary.
- **A host agent that manages a fleet.** Deferred to ADR 0015 (see *Context*).
- **Elicitation answered by the client.** In host-agent mode the client is the agent. Rejected.
- **No destructive tools on a host agent at all.** This remains the default: nothing destructive
  is listed unless `--allow` names it. A handoff costs nothing to allow, so it was preferred over
  hiding the tools outright.
