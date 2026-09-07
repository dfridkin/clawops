---
"@clawops/cli": major
---

Remove `clawops agents restart` and the `clawops_agents_restart` MCP tool

OpenClaw 2.0 has no per-agent restart. `openclaw agents restart` returns "OpenClaw does
not know the command"; the surviving `agents` subcommands are `add`, `bind`, `bindings`,
`delete`, `list`, `set-identity` and `unbind`. The only restarts 2.0 offers are
`gateway restart` and `daemon restart`, and both interrupt every agent on the host.

Aliasing to the gateway-wide restart was the other option and would have been worse: on a
host running several isolated agents it turns a one-agent action into an outage for the
ones you were not touching. `clawops gateway restart` already provides that under a name
that says what it does.

`clawops agents restart` now exits with an explanation pointing at `clawops gateway
restart` rather than doing something larger than its name promises. The MCP tool is
removed outright — it was `destructiveHint: true` with a name implying agent scope, and a
deprecation notice is a safeguard a human reads and an agent routinely does not.

`clawops agents list` and `clawops agents logs` are unaffected. Per-agent log scoping
still exists upstream via `openclaw audit --agent`.

Users who need per-agent restart should stay on the 1.x line (`npm install -g
@clawops/cli@legacy`), which keeps it for OpenClaw &lt;= 2026.7.1-2.
