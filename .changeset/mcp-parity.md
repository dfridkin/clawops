---
'@clawops/cli': minor
---

**Every CLI command an agent needs is now an MCP tool.** Ten new tools bring the catalog to 30:
`clawops_backup_create`, `clawops_backup_restore` (with `activate`), `clawops_gateway_status`,
`clawops_gateway_update`, `clawops_agents_logs`, `clawops_migrate`, `clawops_stacks_delete`,
`clawops_secret_list`, `clawops_secret_audit` and `clawops_secret_delete`. Until now an agent
asked to take a backup before an upgrade, or to recover from one, had to hand the job back to a
human, and the recovery flag 2.2 adds was CLI-only.

Each tool calls the same module as its command, so the two refuse the same things in the same
words. The destructive ones confirm before they run unless `yes: true` is passed, and are left
out of `--read-only` and `--no-destructive`.

**Two things stay CLI-only, on purpose.** `clawops ssh` would give an agent a root shell on the
host that bypasses every refusal and confirmation clawops has, and a prompt injection reaching
the agent would reach it too. `clawops secret set` and `rotate` take a value, and a value passed
as a tool argument lands in the transcript and the model's context. The secret tools return names
and status only, never values, and say which command to ask the user to run.
