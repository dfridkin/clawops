# Host-agent disclosure review

**WO-62 precondition 8.** Date: 2026-10-16. Measured against `ghcr.io/openclaw/openclaw:2026.9.2`,
the pinned release.

A host agent ([ADR 0014](../decisions/0014-host-agent-operator-handoff.md)) runs inside a gateway
that may be connected to many channels and many users. `--read-only` stops it from destroying
anything. It does not stop it from *telling*: if anyone can talk to it, a user in one chat can
ask it what happened in another. This review measures what the read tools would show, and
decides how host-agent mode keeps that from crossing between users.

**Decision (2026-10-16):** limit **who can reach the host agent**, not what its tools return. A
host agent answers only the operator, who may see everything already. Its tools stay complete,
so it has the full context to troubleshoot. Trimming tool output was considered and set aside
(see *Alternatives*): the logs that leak are the same logs a troubleshooter needs.

## How it was measured

1. Started a gateway from the pinned image with a fake OpenAI-compatible model.
2. Ran turns through two agents and three sessions, both from the `openclaw agent` CLI and through
   the gateway's own HTTP chat endpoint. Each inbound message and each reply carried a unique
   marker.
3. Searched for the markers in every source a clawops read tool reads: `openclaw logs --json`,
   `docker logs`, `openclaw audit` and `openclaw.json`.

The gateway-side turn (the HTTP endpoint) is what decides the result. A CLI turn also prints the
reply to its own console, and that output is forwarded into the same log file, so a CLI turn
alone would overstate what the gateway logs.

**What was found:**

| Source | Inbound message text | Reply text | Identifiers |
|---|---|---|---|
| Gateway file log (`openclaw logs`) | Not logged | **Logged**, at `info`, for every session | Session keys appear on diagnostic and error lines |
| Container log (`docker logs`) | Not logged | **Logged** | Session keys appear on error lines |
| Audit, `--kind agent_run` | Not recorded | Not recorded | Agent ID, **session key**, run ID, status. Records are marked `"redaction": "metadata_only"` |
| `openclaw.json` | n/a | n/a | Whatever was written into it, **including literal API keys**. OpenClaw accepts a plain string for `models.providers.*.apiKey` |

**Not measured:**
- What channel plugins (Telegram, Slack and others) add to the log. Running them needs real
  channel accounts.
- How a peer's identity appears in a session key. With the default `session.dmScope: "main"`,
  every DM shares one key, `agent:<id>:main`. The isolated scopes (`per-peer`,
  `per-channel-peer`) were not exercised. Their names suggest the key then identifies the peer.

Neither affects the guardrail below, which keeps other users away from the host agent whatever
the logs contain. Both would matter for a host agent that others can reach (see *Alternatives*).

## The guardrail: the host agent is operator-only

`clawops agent install --stack <name> --agent <id>` names the OpenClaw agent that gets the clawops
tools. Before installing anything, it reads the gateway's `openclaw.json` and **refuses** unless
all of the following hold:

1. **A dedicated agent.** `<id>` is not the default agent (`agents.entries.<id>.default`). The
   default agent receives any traffic no binding claims, so it is reachable by anyone who can
   message the gateway.
2. **Bound only to the operator.** Every `bindings` entry routing to `<id>` names a channel and a
   `peer` of kind `direct` whose ID the operator gave at install, with `--operator
   <channel>:<peer-id>`, repeatable. A binding with no peer, or with a `group` or `channel`
   peer, is refused, because it would route other people's messages to the host agent.
3. **The channel will not let strangers in.** Each such channel's `dmPolicy` is `allowlist` or
   `pairing`, not `open`, so an unknown sender cannot open a DM that a later binding change
   would route to the agent.
4. **No reach across agents.** Other agents cannot read the host agent's sessions, and it cannot
   read theirs. Either `tools.agentToAgent.enabled` is `false`, or its `allow` list leaves `<id>`
   out. `tools.sessions.visibility` must also be `agent` or `self`. On the pinned image
   agent-to-agent access is **on by default** ("omitted or empty allow permits every agent
   pair"), and transcripts are stored in full, so without this check another agent could relay
   what the host agent saw.

The checks run again when the server starts in host-agent mode, and on every
`clawops_status`. If the routing changes later, through `openclaw agents bind` or a config edit,
the server refuses tool calls until the operator re-runs `agent install`. It does not keep
serving under assumptions that no longer hold. `clawops harden` reports the same four checks as
findings.

## The read set in host-agent mode

Because only the operator can reach the agent, the tools return what they return everywhere
else.

| Tool | In host-agent mode |
|---|---|
| `clawops_status`, `clawops_doctor`, `clawops_gateway_status`, `clawops_stacks_list` | Unchanged |
| `clawops_agents_list`, `clawops_agents_logs` | Unchanged: every agent, session keys included |
| `clawops_logs_tail`, `clawops_monitor`, `clawops_workflow_recover` | Unchanged: full logs |
| `clawops_plan`, `clawops_config_validate`, `clawops_task_status` | Unchanged |
| `clawops_config_get` | **Values at secret-named paths are redacted.** This is not about other users: a literal key in `openclaw.json` would otherwise go into the model's context, its transcript and its provider. The operator reads the real values with the CLI |
| `clawops_secret_list`, `clawops_secret_audit` | **Excluded.** The clawops secret store lives on the operator's machine, so on the host it is empty |

**The read set is 13 tools.**

**Acceptance tests in the 2.4 suite:**
- `agent install` is refused for each of the four conditions when it fails. The test changes
  one condition at a time, so a check satisfied by the absence of a binding cannot pass.
- After an install, adding a group binding to the agent makes the next tool call refuse.
- A marked literal key in `openclaw.json` does not appear in a host-agent `config_get` result.

## What the guardrail does not cover

- **Injection through content.** Logs and records hold text written by other users, and the
  host agent reads them. An instruction hidden there can still steer the agent. It cannot make
  anything destructive happen, because under ADR 0014 every destructive call is handed to the
  operator to run.
- **A compromised host or gateway.** Anything that can rewrite `openclaw.json` can reroute
  traffic between the server's checks. T11 covers this.
- **Data reaching the model provider.** Full logs go into the model's context and therefore to
  its provider. That is a choice about the provider, the same one the operator makes for every
  other agent on the gateway.

## Alternatives

- **Trim the tools** (the first version of this review): drop `logs_tail`, strip log lines from
  `monitor` and `workflow_recover`, and limit `agents_logs` to the agent's own records. Set
  aside because a host agent without the logs cannot troubleshoot. It would also have defended
  a case, other users talking to the host agent, that the guardrail now rules out.
- **Redact content, keep structure.** Scrub reply text from logs (in the JSON log it appears as
  forwarded console entries), and replace session keys with stable pseudonyms. This becomes the
  starting point if a host agent that other people can reach is ever wanted. That would be a
  separate decision, and the scrubber would need measuring against real channel plugins first.
- **Hand off the full view.** The agent returns `clawops logs --stack <name>` for the operator
  to run. This remains available under ADR 0014, but it is no longer needed for disclosure.

## Findings outside host-agent mode

Two issues turned up during the review. They apply to every deployment today, not only to a host
agent.

1. **The audit log records the value of `clawops_config_set` in plain text.**
   - The cause: `sanitize` in `src/mcp/audit.ts` redacts by argument *name*. `config_set` takes
     `key` (a config path) and `value`, so `key` matches the `key` pattern and is redacted, while
     the value is logged in clear.
   - Measured: `sanitize({ key: 'models.providers.openai.apiKey', value: 'sk-live-abc123' })`
     returns `{"key":"[REDACTED]","value":"sk-live-abc123"}`.
   - The same value also appears in the tool's confirmation prompt.
   - **Fix:** redact `value` when the config path names a secret, and stop redacting the path.
2. **Literal API keys in `openclaw.json` are returned verbatim by `clawops_config_get`.** clawops
   writes references, not literals. But OpenClaw accepts literals, and an operator or OpenClaw's
   own onboarding can write one. **Fix:** `config_get` and `config validate` flag literal values
   at secret-named paths, and point to `clawops secret set`.
