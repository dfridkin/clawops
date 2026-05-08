# MCP Tool Risk Matrix

All 15 clawops MCP tools, their risk classification, and which safety mode includes them.

## Risk levels

| Level | Meaning |
|---|---|
| **Read-only** | Reads state; no side effects on infrastructure or config |
| **Low** | Triggers non-destructive action (fetch logs, poll status); no config change |
| **Medium** | Modifies config or restarts a process; reversible |
| **High** | Creates or destroys infrastructure; potentially irreversible |

## Tool table

| Tool | Toolset | Risk | `--read-only` | `--no-destructive` | Default |
|---|---|---|:---:|:---:|:---:|
| `clawops_status` | read | Read-only | ✅ | ✅ | ✅ |
| `clawops_logs_tail` | read | Read-only | ✅ | ✅ | ✅ |
| `clawops_stacks_list` | read / admin | Read-only | ✅ | ✅ | ✅ |
| `clawops_config_get` | read | Read-only | ✅ | ✅ | ✅ |
| `clawops_agents_list` | read | Read-only | ✅ | ✅ | ✅ |
| `clawops_plan` | cli | Low | ❌ | ✅ | ✅ |
| `clawops_task_status` | cli | Read-only | ❌ | ✅ | ✅ |
| `clawops_workflow_recover` | workflow | Low | ❌ | ✅ | ✅ |
| `clawops_config_set` | cli | Medium | ❌ | ❌ | ✅ |
| `clawops_agents_restart` | cli | Medium | ❌ | ❌ | ✅ |
| `clawops_gateway_restart` | cli | Medium | ❌ | ❌ | ✅ |
| `clawops_up` | cli | High | ❌ | ❌ | ✅ |
| `clawops_destroy` | cli | High | ❌ | ❌ | ✅ |
| `clawops_apply` | cli | High | ❌ | ❌ | ✅ |
| `clawops_workflow_deploy_app` | workflow | High | ❌ | ❌ | ✅ |

`--read-only` enables 5 tools. `--no-destructive` enables 8 tools. Default enables all 15.

## Annotations

Each tool's `readOnlyHint` and `destructiveHint` annotations are set in
`spec/mcp-tools.yaml` and generated into `src/mcp/tools/_generated.ts`. The server
reads these at startup to build the enabled-tool set for the chosen safety mode.

## Elicitation

Tools with `destructiveHint: true` prompt for confirmation before executing unless
the caller passes `yes: true` explicitly. In default mode an agent that issues
`clawops_destroy` without `yes: true` will receive a confirmation prompt rather than
immediately destroying infrastructure.

See [mcp-safety.md](mcp-safety.md) for how to choose a mode and [read-only.md](../mcp/read-only.md) for
step-by-step configuration instructions.
