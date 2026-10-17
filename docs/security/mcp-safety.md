# MCP Safety Modes

clawops exposes its operations as an MCP server. By default the server enables all
30 tools, including destructive ones like `clawops_destroy` and `clawops_up`. For
most agent integrations you should restrict the tool set.

## Three safety modes

### `--read-only` (recommended for most setups)

Enables the **15 tools** in the curated `read` toolset, no writes, no infrastructure
changes:

- `clawops_status`
- `clawops_logs_tail`
- `clawops_stacks_list`
- `clawops_config_get`
- `clawops_config_validate`. Validate the remote openclaw.json (read-only check)
- `clawops_agents_list`
- `clawops_agents_logs`, one agent's activity
- `clawops_gateway_status`, whether the gateway container is running
- `clawops_secret_list` and `clawops_secret_audit`, names and references only, never values
- `clawops_plan`. Generate a deploy plan (no infra changes)
- `clawops_task_status`, poll an in-progress task
- `clawops_workflow_recover`. Diagnose an unhealthy stack: status, failed health checks, recent logs

Use this when you want an AI assistant that can answer questions, generate plans for
human review, and run recovery diagnostics, but cannot apply any changes.

### `--no-destructive`

Enables 17 tools with default toolsets: the read toolset plus `clawops_init` and
`clawops_backup_create`, which write locally but destroy nothing. The mechanism differs too: `--no-destructive` filters the active toolset by
removing any tool with `destructiveHint: true`, making it composable with
`--toolsets` for custom configurations.

Use this when you need fine-grained toolset control alongside the destructive-tool
block.

### Default (all tools)

Enables all **30 tools**, including the 13 destructive ones: `clawops_up`,
`clawops_destroy`, `clawops_apply`, `clawops_config_set`, `clawops_config_unset`,
`clawops_gateway_restart`, `clawops_gateway_update`, `clawops_harden`,
`clawops_backup_restore`, `clawops_migrate`, `clawops_stacks_delete`, `clawops_secret_delete`,
`clawops_workflow_deploy_app`.

Destructive tools still require `yes: true` in the tool call, without it, the
server issues a confirmation prompt. This is a safeguard against accidental
execution, not a security boundary.

Use this in a controlled CI/CD context where the agent has explicit permission to
manage infrastructure.

### `--host-agent` (on the gateway host, 2.4)

A host agent is clawops running on the gateway host, so the gateway's own AI can look after its
deployment ([ADR 0014](../decisions/0014-host-agent-operator-handoff.md)). It is a server mode,
not a toolset, and it fixes the tool set: `--read-only`, `--no-destructive` and `--toolsets` are
refused alongside it.

- **Only its own stack.** It manages the host it runs on. A call naming any other stack is
  refused before a tool runs. Its tools run locally, with no SSH, no Pulumi state, no clawops
  config and no cloud credentials.
- **12 read tools.** The read toolset except `clawops_plan`, `clawops_secret_list` and
  `clawops_secret_audit`, which need the operator's machine. `clawops_config_get` hides strings
  at secret-named paths, keeping `${VAR}` references and SecretRef objects visible.
- **Destructive tools hand off.** Only those the operator allowed at install are listed, and
  only `gateway_restart`, `gateway_update`, `backup_restore`, `config_set`, `config_unset` and
  `harden` can be allowed. A call changes nothing: it returns the exact `clawops` command for the
  operator to run on their own machine, with secrets replaced by `<value>`, and records it in
  `handoffs.jsonl` on the host. `yes: true` and elicitation answers are ignored. The operator's
  `clawops status` and `clawops_status` show what is pending, and running the command clears
  it. The agent can write that file, so it can forge a request or hide one of its own; it
  cannot make one run.
- **Never self-targeting.** `clawops_destroy`, `clawops_stacks_delete` and `clawops_migrate`
  cannot be allowed and are refused with no command offered.
- **Operator-only, re-checked on every call.** Every call is refused while `openclaw.json` lets
  anyone but the operator reach the agent, or lets another agent call clawops
  ([review](host-agent-disclosure-review.md)).
- **Other agents in the gateway container are reported, not refused.** On a default deployment
  every agent has `exec` and file tools in the container. Any of them can read the clawops token
  from `openclaw.json` and the host agent's transcripts from disk. `clawops_status` names them;
  install with `--strict` to refuse instead.

### Spending limits apply in every mode

An agent with full access still deploys only what `~/.clawops/config.json → policy` allows:
`clawops_plan`, `clawops_apply`, `clawops_up` and `clawops_workflow_deploy_app` refuse a server
size outside `allowedInstanceTypes`, and `clawops_init` refuses a stack beyond `maxStacks`. No
tool can change the policy; the operator sets it with `clawops setup` or by editing the file.
Unlike confirmation, which an agent can answer for itself, this is a limit the agent cannot lift.

## Choosing a mode

| Context | Recommended mode |
|---|---|
| Day-to-day assistant (Claude Code, Cursor) | `--read-only` |
| Agent that drafts plans for human review | `--no-destructive` |
| Automated CI/CD pipeline with explicit approval gate | default |
| Shared team environment | `--read-only` or `--no-destructive` |

## Configuring the mode

The safety flag goes in the MCP server args, not at connection time. After
`clawops mcp install`, open the generated config and add the flag:

```json
{
  "mcpServers": {
    "clawops": {
      "command": "clawops",
      "args": ["mcp", "serve", "--read-only"]
    }
  }
}
```

Replace `--read-only` with `--no-destructive` or omit entirely for default mode.

See [read-only.md](../mcp/read-only.md) for client-specific configuration steps and
[tool-risk-matrix.md](tool-risk-matrix.md) for the full per-tool breakdown.

## What `--read-only` does NOT protect against

- An agent reading config values that happen to contain sensitive data (the config
  is fetched and returned; `clawops_config_get` is a read-only tool). Do not store
  raw secrets in `openclaw.json`. Use environment variable references instead.
- An agent that has other tools available (e.g., a `bash` tool in the same session)
  running `clawops up` via the CLI directly.
- Network-level access to the gateway. `--read-only` restricts the MCP tools only.

## Audit logging

All tool calls are logged regardless of safety mode. See
[audit-logs.md](audit-logs.md) for log location, format, and what is redacted.
