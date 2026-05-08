# Using clawops with Cursor

This guide covers connecting clawops to Cursor and choosing the right safety mode.

## Install

```bash
clawops mcp install
```

This writes a `clawops` entry to `.cursor/mcp.json` (project-level) if a `.cursor/`
directory is detected, otherwise to `~/.cursor/mcp.json` (global).

The entry uses `["mcp", "serve"]` with no safety flag. **Add `--read-only` before
use** — see below.

## Manual configuration

### Project-level (recommended)

Create or edit `.cursor/mcp.json` in your project root:

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

Commit this file to give all project collaborators the same read-only access.

### Global

Edit `~/.cursor/mcp.json`:

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

After saving either file, reload Cursor's MCP servers (Settings → MCP → Reload).

## Choosing a safety mode

| You want | Flag |
|---|---|
| Query-only — status, logs, config reads | `--read-only` |
| Plan generation + monitoring, no writes | `--no-destructive` |
| Full control (deploy, destroy, config writes) | *(no flag)* |

See [mcp-safety.md](../security/mcp-safety.md) for a full description of each mode
and [tool-risk-matrix.md](../security/tool-risk-matrix.md) for the per-tool breakdown.

## Common workflows

**Check gateway health:**
> Is my OpenClaw gateway up?

Cursor calls `clawops_status` and returns the current state.

**Tail logs:**
> Show me the last 30 lines of gateway logs.

**Generate a deploy plan:**
> Generate a plan to deploy OpenClaw on GCP us-central1 with my default credentials.

Requires `--no-destructive` or full access. The plan JSON is returned for review.

## Security notes

- For shared repositories, commit `.cursor/mcp.json` with `--read-only` so
  collaborators don't accidentally enable full access.
- Cursor's agent mode can chain multiple tool calls. With full access enabled, a
  single prompt like "deploy and configure" could trigger several destructive
  operations. Use `--no-destructive` unless you specifically need infra changes.
- All tool calls are logged to `~/.clawops/mcp-audit.log`. See
  [audit-logs.md](../security/audit-logs.md).

## Troubleshooting

**Tools not appearing in Cursor:**
- Confirm `clawops` is in your PATH: run `which clawops` in a Cursor terminal
- Check Settings → MCP for server status and error messages
- Re-run `clawops mcp install` and reload MCP servers

**Permission denied errors:**
- Ensure the clawops config directory exists: `ls ~/.clawops/`
- Run `clawops doctor` to check SSH key and host connectivity
