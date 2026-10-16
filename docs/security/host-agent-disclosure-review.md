# Host-agent disclosure review

**WO-62 precondition 8.** Date: 2026-10-16. Measured against `ghcr.io/openclaw/openclaw:2026.9.2`,
the pinned release.

A host agent ([ADR 0014](../decisions/0014-host-agent-operator-handoff.md)) is reachable from
every channel the gateway is connected to. `--read-only` stops it from destroying anything. It
does not stop it from *telling*: a user in one channel can ask it what happened in another. This
review checks each tool in the `read` toolset for what it would show such a user, and decides
which tools the host-agent mode keeps.

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

Both should be checked before 2.4 ships. Neither changes a verdict below, because both point the
same way.

## Verdicts

| Tool | Exposes, in host-agent mode | Verdict |
|---|---|---|
| `clawops_status` | Stack and infrastructure state | **Keep** |
| `clawops_doctor` | Health-check results | **Keep** |
| `clawops_gateway_status` | Whether the container runs, and its image | **Keep** |
| `clawops_stacks_list` | Stack names on the host, which is only its own stack | **Keep** |
| `clawops_agents_list` | Agent IDs, workspace paths and binding counts. No content | **Keep** |
| `clawops_plan` | Generates a plan; no deployment content | **Keep** |
| `clawops_config_validate` | Schema errors by path | **Keep** |
| `clawops_task_status` | Status of the agent's own tasks | **Keep** |
| `clawops_monitor` | Container metrics, plus a tail of the container log, which includes replies from every session | **Filter:** no log lines in host-agent mode |
| `clawops_workflow_recover` | Status and health checks, plus recent logs | **Filter:** no logs step in host-agent mode; the status and health checks stay |
| `clawops_agents_logs` | Run metadata for **any** agent named, including session keys | **Filter:** only the agent configured at `agent install --agent <id>`, with `sessionKey` removed from records |
| `clawops_logs_tail` | The gateway log: every session's reply text | **Exclude.** The reply lines carry no session key, so they cannot be filtered to the asking session |
| `clawops_config_get` | All of `openclaw.json`, unredacted: literal keys, every agent's routing, and channel allowlists naming other users | **Exclude.** `config_validate` covers diagnosis. Redaction would have to be right about every plugin's key names to be safe |
| `clawops_secret_list`, `clawops_secret_audit` | The clawops secret store. That store lives on the operator's machine, so on the host it is empty | **Exclude.** Nothing to show, and no reason to carry the surface |

**The host-agent read set is 11 tools:**
- 8 kept as they are
- 3 filtered: `clawops_monitor`, `clawops_workflow_recover`, `clawops_agents_logs`

4 tools are excluded. Each filter is a host-agent-mode branch in the shared module that the tool
already calls, so the CLI does not change. Each filter and exclusion gets an acceptance test in
the 2.4 suite: a marker sent in one session must not appear in any host-agent tool result.

## OpenClaw's own defaults

On this image `tools.agentToAgent` is **enabled by default**: "omitted or empty allow permits
every agent pair". The setting lets one agent list, read and search another agent's sessions,
and session transcripts are stored in full in each agent's SQLite store. This exposure comes from
OpenClaw itself, not from a clawops tool, so filtering clawops tools does not close it.

**For 2.4:** if more than one agent is configured, `clawops agent install` reports the setting
and refuses unless `tools.agentToAgent.allow` is restricted, or the operator passes an explicit
override. `clawops harden` gains the same check as a finding.

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
