# ADR 0014, Host agent with operator-signed approval

**Status:** Proposed
**Date:** 2026-10-05
**Deciders:** Project owner
**Revisit:** before 2.3 ships, and again after the first quarter of host agents in use

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

Two decisions were taken on 2026-10-05: 2.3 ships **local and cloud together**, behind all nine
preconditions; and destructive calls are **approved by the operator from their own machine**.

## Decision

### 1. Host-agent mode is a server mode, not a toolset

`clawops mcp serve --host-agent` runs on the gateway host as its own systemd unit,
`clawops-agent.service`, separate from `openclaw.service`. A gateway restart does not stop it.
It is installed by the operator with `clawops agent install --stack <name>`, from the operator's
machine, over the existing SSH transport. In host-agent mode:

- **`yes` is ignored by every tool.** It is not removed from the schema, which would make the
  same tool behave differently by mode. It is read and discarded, and the result says so.
- **The tool set is fixed by the mode**, not by `--toolsets`: the read toolset after the
  disclosure review (precondition 8), plus the destructive tools the operator allowed at install
  time with `--allow <tool,...>`. Nothing destructive is allowed by default.
- **Elicitation is not consulted.** A confirmation answered by the gateway's client is answered by
  the same agent this mode exists to contain.

### 2. A destructive call becomes a pending approval

When an allowed destructive tool is called in host-agent mode, it does not run. The server:

1. Applies the self-targeting guard (§3). A refused call ends here.
2. Writes a **pending approval** to `/var/lib/clawops-agent/approvals/<id>.json`: the tool, its
   arguments with secrets redacted by the same rules as the audit log, the stack, the time, an
   expiry (default 15 minutes), and `digest = sha256(tool + canonical JSON of the full arguments)`.
3. Returns a task id, with status `awaiting-approval` and the text an operator needs:
   `clawops approvals list --stack <name>` on their machine.

The agent polls with `clawops_task_status`, which gains three states: `awaiting-approval`,
`denied` and `expired`. **No tool is added** (precondition 9).

### 3. The self-targeting guard refuses before approval is possible

Some operations end the host or the stack the agent runs on. Approving them from far away is
exactly the incident WO-62 was written to prevent, so the guard refuses them in host-agent mode
whatever is approved: `destroy` and `down` of its own stack, `stacks_delete` of its own stack,
and `migrate` of its own host. These are done by the operator, from their machine, with the CLI.

Operations that change the host but leave it running — `gateway_restart`, `gateway_update`,
`backup_restore` with `activate`, `config_set`, `config_unset`, `harden` — are **not refused**.
They require approval. This refines amended precondition 2, which listed them for refusal: that
was written before an approval mechanism existed. With one, routine maintenance of the host is
what the feature is for, and clawops runs in its own unit and survives the gateway restarting.

The guard lives in the server's dispatch, below every tool handler, keyed on the stack named in
the host-agent unit's configuration. It cannot be argued with through a tool's arguments.

### 4. The operator signs the approval with a key the host does not hold

`clawops approvals list|approve|deny <id> --stack <name>` runs on the operator's machine. It
reads pending approvals over SSH, shows the tool, the arguments and the digest, and on `approve`
writes `<id>.approval` back over SSH: the id, the digest, the expiry, and an **Ed25519 signature
over those three, made with the operator's SSH key** (`~/.clawops/config.json → ssh.keyPath`).

The host agent verifies the signature against the operator's public key, pinned at install time
in a root-owned file the agent's user cannot write. It then runs **exactly the call whose digest
was signed**, once, and records the result on the task. An approval for a different digest, after
expiry, or for an id already used, is rejected and recorded.

Signing and verification use `ssh2`'s key parsing, which clawops already depends on. No new
network surface: the approval travels over the SSH connection the operator already uses, checked
against the same pinned host keys.

`approvals` is a CLI command with **no MCP tool, by design**. An agent that can approve is the
problem this ADR solves. It goes in `NO_TOOL` in `tests/mcp/parity.test.ts` with that reason.

### 5. The other preconditions

| # | Precondition | How 2.3 meets it |
|---|---|---|
| 1 | Spend ceiling, enforced | An instance-type allowlist and a stack cap in the deploy-plan schema, checked by `plan` and `apply` on every surface; on cloud, `agent install` refuses unless a provider budget with an enforcement action exists |
| 2 | Self-targeting guard | §3 |
| 3 | Narrow cloud identity | `agent install` creates a host role from a per-cloud template: no delete on resources tagged with its own stack, no instance types outside the allowlist. Local: no cloud identity exists |
| 4 | State the host cannot delete | The host role reads and writes its own stack's state prefix and has no delete on the bucket. Local: no cloud state |
| 5 | Audit off-host | Cloud: the audit log streams to the provider's log service through a role that can append and not delete. Local: every approval is also recorded on the operator's machine when it is signed, and `clawops approvals list` pulls the host's audit log |
| 6 | Break-glass operator | The holder of the approval key. `agent install` records who that is and refuses without it; the docs say what they need and where |
| 7 | Read-only default, `yes` not honoured | §1 |
| 8 | Disclosure review | Done before the read set is fixed; tools that expose other channels' activity are left out of host-agent mode or filtered |
| 9 | Tool budget | No new tools: approvals use `clawops_task_status`, operator commands are CLI-only |

### 6. Acceptance is an e2e test per precondition

On the 2.2 harness (systemd target, built server, SDK client), each precondition is done when a
test that would pass without it fails. At minimum:

- An allowed destructive call returns `awaiting-approval` and changes nothing on the host.
- The same call with `yes: true` returns `awaiting-approval` and changes nothing.
- An approval signed by a key other than the pinned one is rejected, and nothing runs.
- An approval signed for one digest does not run a call with different arguments.
- A valid approval runs the call once; replaying it runs nothing.
- `destroy` of the agent's own stack is refused even with a valid approval.
- A tool not allowed at install time is not listed in `tools/list`.

## R-meta-3: the rules this bends

**R6, credentials never in tool args.** Its letter holds: no tool takes a credential. Its intent
does not, on cloud: the host carries a standing identity, reachable by anything that achieves
execution there. *Mitigation:* the identity is narrow (precondition 3), cannot delete state (4),
cannot exceed the allowlist (1), and every use is audited off-host (5). *Revisit:* if a provider
offers per-call credentials that a remote operator can mint, use those instead.

**R19, elicitation before destruction.** In host-agent mode elicitation is not consulted, and
`yes` is ignored. That strengthens R19's intent, which is that destruction needs a human, while
departing from its mechanism. *Mitigation:* §2–§4. *Revisit:* when MCP has a way for a server to
reach a human that does not go through the calling client.

## Consequences

**Positive:**
- A model cannot approve its own destructive call, through any argument or any client.
- The gateway can still maintain itself, under the operator's signature.
- No tool is added, and no network listener.
- The approval mechanism is usable beyond host agents later, for any client the operator does
  not trust with `yes`.

**Negative:**
- Approval latency is a human's latency. An unattended host waits, then expires.
- The operator needs their machine, their key and SSH reach to approve. On a private-only stack
  that means the tailnet.
- Anything with root on the host can replace the pinned key. The scheme defends against the
  model, not against a host already compromised; T11 says so.

**Neutral:**
- `clawops_task_status` gains three states, and its description changes accordingly.

## Alternatives Considered

- **Elicitation answered by the client.** In host-agent mode the client is the agent. Rejected.
- **A designated operator channel.** The approval would travel through the same gateway an
  injection arrives through, and binding a message to a person is the hard part. Rejected for
  2.3; revisit if OpenClaw gains signed messages.
- **No destructive tools on a host agent at all.** Simplest and safest, and rejected because it
  removes most of what WO-62 is for. It remains the default: nothing destructive is allowed
  unless `--allow` names it.
- **A shared secret instead of a signature.** It would live on the host the agent runs on, which
  is the one place it must not be.
