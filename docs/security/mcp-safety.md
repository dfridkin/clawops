# MCP Safety Modes

clawops exposes its operations as an MCP server. By default the server enables all
17 tools, including destructive ones like `clawops_destroy` and `clawops_up`. For
most agent integrations you should restrict the tool set.

## Three safety modes

### `--read-only` (recommended for most setups)

Enables **9 tools** from the curated `read` toolset — no writes, no infrastructure
changes:

- `clawops_status`
- `clawops_logs_tail`
- `clawops_stacks_list`
- `clawops_config_get`
- `clawops_config_validate` — validate the remote openclaw.json (read-only check)
- `clawops_agents_list`
- `clawops_plan` — generate a deploy plan (no infra changes)
- `clawops_task_status` — poll an in-progress task
- `clawops_workflow_recover` — investigate a stuck deployment (reads logs + status)

Use this when you want an AI assistant that can answer questions, generate plans for
human review, and run recovery diagnostics — but cannot apply any changes.

### `--no-destructive`

Enables the same **9 tools** as `--read-only` when used with default toolsets. The
difference is the mechanism: `--no-destructive` filters the active toolset by
removing any tool with `destructiveHint: true`, making it composable with
`--toolsets` for custom configurations.

Use this when you need fine-grained toolset control alongside the destructive-tool
block.

### Default (all tools)

Enables all **17 tools**, including the 8 destructive ones: `clawops_up`,
`clawops_destroy`, `clawops_apply`, `clawops_config_set`, `clawops_config_unset`,
`clawops_agents_restart`, `clawops_gateway_restart`, `clawops_workflow_deploy_app`.

Destructive tools still require `yes: true` in the tool call — without it, the
server issues a confirmation prompt. This is a safeguard against accidental
execution, not a security boundary.

Use this in a controlled CI/CD context where the agent has explicit permission to
manage infrastructure.

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
  raw secrets in `openclaw.json` — use environment variable references instead.
- An agent that has other tools available (e.g., a `bash` tool in the same session)
  running `clawops up` via the CLI directly.
- Network-level access to the gateway — `--read-only` restricts the MCP tools only.

## Audit logging

All tool calls are logged regardless of safety mode. See
[audit-logs.md](audit-logs.md) for log location, format, and what is redacted.
