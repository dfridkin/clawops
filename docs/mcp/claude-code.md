# Using clawops with Claude Code

This guide covers connecting clawops to Claude Code (Claude Desktop and the
`claude` CLI), choosing a safety mode, and common agent workflows.

## Install

```bash
clawops mcp install
```

This writes a `clawops` entry to:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

The entry uses
`["mcp", "serve"]` with no safety flag — all 15 tools are enabled by default.

**Recommendation:** Add `--read-only` before first use:

1. Open the config file the command wrote to.
2. Find the `clawops` entry and change `"args"` to:
   ```json
   ["mcp", "serve", "--read-only"]
   ```
3. Restart Claude Desktop (or reload the MCP server in Claude Code settings).

For step-by-step config examples see [read-only.md](read-only.md).

## Verifying the connection

After restarting, open a new conversation in Claude and ask:

> What is the status of my clawops deployment?

Claude should call `clawops_status` and return the result. If you see a tool call
in the conversation, the server is connected.

If the tool does not appear, check `~/Library/Logs/Claude/mcp-server-clawops.log`
(macOS) for startup errors.

## Recommended workflows by safety mode

### Read-only (monitoring and Q&A)

Useful questions to ask Claude with `--read-only`:

- "Is my OpenClaw gateway healthy?"
- "Show me the last 50 lines of gateway logs."
- "What is my current gateway auth token?" (note: value is returned as-is)
- "List all my stacks."
- "Are any agents running?"

### No-destructive (planning)

With `--no-destructive`, Claude can also:

- "Generate a plan to deploy a new OpenClaw instance on AWS."
- "What would it cost/change to upgrade to a larger instance?"
- "Check the status of that deploy task."

Review the generated plan JSON before applying it with `clawops apply <plan.json>`.

### Full access (automated deploys)

With all tools enabled, Claude can execute full deploy workflows. Always confirm
before destructive actions — the server will prompt if `yes: true` is not set.

Example prompt:
> Deploy a new OpenClaw instance on AWS us-east-1, t3.small. Use my default AWS
> profile. Let me review the plan before applying.

Claude will call `clawops_plan`, show you the plan, then ask for confirmation
before calling `clawops_apply`.

## Security notes

- `--read-only` is appropriate for most day-to-day use. Enable full access only
  when you specifically intend to change infrastructure.
- If the conversation contains a `bash` tool or other shell-access tools, `--read-only`
  does not prevent the agent from running `clawops up` via the CLI.
- `clawops_config_get` returns config values including any tokens stored in
  `openclaw.json`. Prefer environment variable references over inline secrets.
- All tool calls are logged to `~/.clawops/mcp-audit.log`. See
  [audit-logs.md](../security/audit-logs.md).

## Troubleshooting

**"No tools available" / clawops tools not shown:**
- Confirm `clawops` is in your PATH: `which clawops`
- Check the MCP server log for startup errors
- Re-run `clawops mcp install` and restart Claude Desktop

**Tool call returns an error about stack not found:**
- Run `clawops init` first to configure the target host
- Run `clawops doctor` to check prerequisites

**Elicitation prompt appears for a read-only query:**
- You may be running with full tool access. Add `--read-only` to the args if you
  only need observability.
