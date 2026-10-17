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

1. **A dedicated agent.** `<id>` is not the default agent. The default agent receives any
   traffic no binding claims, so it is reachable by anyone who can message the gateway. On the
   pinned image (`resolveDefaultAgentId`) the default is the one entry marked `default`, or else
   the only agent. If several agents exist and none is marked, there is no default and an
   unclaimed message fails to route. The check counts any `default: true` marker, and being the
   only agent.
   - **Nothing else routes to it.** Bindings are not the only way traffic reaches an agent.
     Telegram topics, `hooks.mappings`, the IMAP plugin, `talk`, `acp.defaultAgent` and
     `agents.defaults.systemAgent` each name an agent, and several carry messages from other
     people. Any `agentId`, `defaultAgent` or `defaultAgentId` outside `bindings` that names
     `<id>` fails the check.
2. **Bound only to the operator.** At least one binding routes to `<id>`, and every one of them
   names a channel and a `peer` of kind `direct` whose ID the operator gave at install, with
   `--operator <channel>:<peer-id>`, repeatable. A binding with no peer, a `group` or `channel`
   peer, a wildcard peer ID or an ACP binding is refused, because it would route other people's
   messages to the host agent.
3. **The channel will not let strangers in.** Each such channel's `dmPolicy`, or its account's
   when the binding names an `accountId`, is set explicitly to `allowlist`, `pairing` or
   `disabled`, not `open`. That way an unknown sender cannot open a DM that a later binding
   change would route to the agent. An unset policy is refused even where the channel's default
   is `pairing`, so the guarantee does not rest on a default that a release could change.
4. **No reach across agents.** Other agents cannot read the host agent's sessions, and it cannot
   read theirs. Either `tools.agentToAgent.enabled` is `false`, or its `allow` list leaves `<id>`
   out. `tools.sessions.visibility` must also be `agent` or `self`. On the pinned image
   agent-to-agent access is **on by default** ("omitted or empty allow permits every agent
   pair"), and transcripts are stored in full, so without this check another agent could relay
   what the host agent saw.
5. **No other agent can call clawops** ([SP-13](../spikes/SP-13-host-agent-mcp-scoping.md)).
   - **Every other agent must be denied.** OpenClaw offers every MCP tool to every agent by
     default. Each other agent in `agents.entries` must carry a `tools.deny` entry covering every
     clawops name, the bridge's `prompts_*` and `resources_*` tools included. `clawops__*` does
     this.
   - **A gateway-wide deny is refused.** A `tools.deny` that blocks clawops for everyone cannot be
     reopened for one agent.

**The checks run on every tool call**, against `openclaw.json` as it is at that moment. This
matters because OpenClaw's layout fails open:
- An agent added later gets the clawops tools unless it is denied too.
- A binding added with `openclaw agents bind` takes effect without a restart.
- The server cannot tell which agent is calling.

So while any condition fails, every call is refused, `clawops_status` included, and the refusal
lists what failed. An unreadable configuration counts as failing. The server resumes on its own
once the configuration is fixed. The checks live in `src/hostagent/guardrail.ts`.

## Condition 6: other agents inside the gateway container

Conditions 1–5 control who can **message** the host agent and which agents the gateway's tool
bridge offers clawops to. They do not control what other agents can do **inside the gateway
container**, and on a default deployment that is enough to get around both.

**Measured on 2026.9.2** (2026-10-16), with the gateway configured as `clawops up` leaves it and a
fake model logging the tools each request offered:

- **An agent with no tool settings is offered everything,** including `exec`, `process`,
  `terminal`, `read`, `write`, `edit`, `apply_patch`, the file-transfer plugin's `file_fetch`,
  `file_write`, `dir_list` and `dir_fetch`, and `gateway`.
- **Sandboxing is off by default** (`agents.defaults.sandbox.mode` resolves to `"off"`). An `exec`
  call ran in the gateway container as uid 1000, the gateway's own user. It listed the state
  directory, every agent's transcripts included, and printed `openclaw.json`.
- **What removes these tools:**

  | Setting | Container tools offered |
  |---|---|
  | `tools.profile: "messaging"` or `"minimal"` | none |
  | An explicit `tools.allow` list | only those listed |
  | `tools.deny: ["group:runtime", "group:fs"]` | `terminal`, `file_fetch`, `file_write`, `dir_list`, `dir_fetch`, `gateway` remain |
  | `"messaging"` plus `alsoAllow: ["exec"]` | `exec` |

**What follows.** An agent with these tools can:
- **Read the clawops token.** The gateway stores it in `openclaw.json`. With it, the agent can
  call the host agent over HTTP directly, past the condition 5 deny, and the server cannot tell
  that caller from the host agent.
- **Read the host agent's transcripts from disk,** past `tools.sessions.visibility`.

What it does **not** gain is any change to the stack. Every destructive call still hands off to
the operator. Through the token it reaches the host agent's read tools, which on top of what the
container already shows add host-level reads: systemd, firewall and SSH configuration, Docker
state.

**What clawops does about it.** Because most gateways' main agent has `exec`, and requiring
otherwise would break them, condition 6 is **reported, not refused**, unless the operator installs
with `--strict`:
- **Default.** `agent install` lists every other agent that can run commands, read or write
  files, or change the gateway configuration in the container, and `clawops_status` reports them
  as `otherAgentsInContainer`.
- **`--strict`.** Any such agent fails the guardrail like conditions 1–5, re-checked on every
  call.

**How it is judged.** An agent counts unless its settings provably exclude each tool:
- **A deny removes a tool.** `group:runtime` and `group:fs` count only for the members measured
  above.
- **What adds tools back.** An `alsoAllow`, an `allow` list, or a profile other than `minimal` or
  `messaging`, at the agent or gateway level.
- **Overrides count as grants.** A `byProvider` or `toolsBySender` override that grants a tool
  counts, since nothing measured shows the base deny winning over it.
- **Unknown groups count as everything.** An `allow` entry naming a group not measured is
  assumed to grant everything.

**The proper fix** is sandboxing other agents (`sandbox.mode: "all"`), which runs their tools in
separate containers. That needs Docker access from inside the gateway container, which clawops
does not provision. It is deferred to 2.5 with ADR 0015.

## The read set in host-agent mode

Because only the operator can reach the agent, the tools return what they return everywhere
else.

| Tool | In host-agent mode |
|---|---|
| `clawops_status`, `clawops_doctor`, `clawops_gateway_status`, `clawops_stacks_list` | Unchanged |
| `clawops_agents_list`, `clawops_agents_logs` | Unchanged: every agent, session keys included |
| `clawops_logs_tail`, `clawops_monitor`, `clawops_workflow_recover` | Unchanged: full logs |
| `clawops_config_validate`, `clawops_task_status` | Unchanged |
| `clawops_plan` | **Excluded.** Planning needs the operator's config and Pulumi state, which the host does not hold ([ADR 0014](../decisions/0014-host-agent-operator-handoff.md), revised 2026-10-16) |
| `clawops_config_get` | **Values at secret-named paths are redacted.** This is not about other users: a literal key in `openclaw.json` would otherwise go into the model's context, its transcript and its provider. The operator reads the real values with the CLI |
| `clawops_secret_list`, `clawops_secret_audit` | **Excluded.** The clawops secret store lives on the operator's machine, so on the host it is empty |

**The read set is 12 tools.**

**Acceptance tests in the 2.4 suite:**
- The guardrail refuses for each condition when it fails (`tests/hostagent/guardrail.test.ts`).
  The test changes one condition at a time, so a check satisfied by the absence of a binding
  cannot pass. `agent install` runs the same check.
- After an install, adding a group binding to the agent makes the next tool call refuse, and so
  does adding an agent without the deny.
- A marked literal key in `openclaw.json` does not appear in a host-agent `config_get` result.

## What the guardrail does not cover

- **Injection through content.** Logs and records hold text written by other users, and the
  host agent reads them. An instruction hidden there can still steer the agent. It cannot make
  anything destructive happen, because under ADR 0014 every destructive call is handed to the
  operator to run.
- **Other agents inside the gateway container**, unless installed with `--strict`. See
  condition 6.
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

1. **The audit log records the value of `clawops_config_set` in plain text.** *Fixed in 2.3.1.*
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
