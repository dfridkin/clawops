# Read-Only Mode

Running clawops in `--read-only` mode limits the MCP server to the **11 tools** in the
curated `read` toolset. The agent can answer questions, diagnose a deployment, generate
plans for human review, and run recovery diagnostics — but cannot apply any changes.

## What `--read-only` enables

| Tool | What it does |
|---|---|
| `clawops_status` | Show what is deployed for a stack — outputs, not health |
| `clawops_doctor` | Diagnose the local machine and, with a stack, the deployment |
| `clawops_logs_tail` | Stream recent container logs |
| `clawops_monitor` | Sample gateway and host metrics |
| `clawops_stacks_list` | List known stacks and their last-known state |
| `clawops_config_get` | Read a value from the OpenClaw config |
| `clawops_config_validate` | Validate the deployed config against the OpenClaw schema |
| `clawops_agents_list` | List running agents and their status |
| `clawops_plan` | Generate a deploy plan JSON (no infrastructure changes) |
| `clawops_task_status` | Poll the status of an in-progress background task |
| `clawops_workflow_recover` | Investigate a stuck deployment (reads logs + status) |

All write, restart, and infrastructure tools are disabled at server startup. The
disabled tools are not registered — they never appear in the tool list sent to the
AI client.

## Configuration

### Claude Code

Open `~/.claude/claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`) and add or update the `clawops` entry:

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

Restart Claude Desktop after saving.

### Cursor

Open `.cursor/mcp.json` in your project root (or `~/.cursor/mcp.json` globally):

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

### VS Code (Copilot MCP extension)

Open `.vscode/mcp.json` in your workspace:

```json
{
  "servers": {
    "clawops": {
      "type": "stdio",
      "command": "clawops",
      "args": ["mcp", "serve", "--read-only"]
    }
  }
}
```

### Zed

In `~/.config/zed/settings.json`, under `context_servers`:

```json
{
  "context_servers": {
    "clawops": {
      "command": {
        "path": "clawops",
        "args": ["mcp", "serve", "--read-only"]
      }
    }
  }
}
```

## Upgrading to `--no-destructive`

If you want to allow the agent to generate plans and check task status but still
block config writes and infrastructure changes, replace `--read-only` with
`--no-destructive` in the args array. Both modes currently enable the same 11 tools; the
difference is the mechanism. `--read-only` serves one fixed toolset, while
`--no-destructive` filters `destructiveHint: true` out of whatever toolsets are active — so
it is the one to combine with `--toolsets`.

## Upgrading to full access

Remove the flag entirely to enable all 18 tools. Destructive tools will still
require `yes: true` in the call — the agent sees a confirmation prompt without it.

See [mcp-safety.md](../security/mcp-safety.md) for a full description of each mode
and [tool-risk-matrix.md](../security/tool-risk-matrix.md) for the per-tool breakdown.
