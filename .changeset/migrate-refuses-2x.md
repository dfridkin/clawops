---
'@clawops/cli': patch
---

**`clawops migrate` refuses a stack that is already on 2.x, and asks before it runs.** On a 2.x
stack it would have taken a backup, stopped the gateway, and replaced a working config with the
minimal one it synthesises for 1.x, because both lines name their container `openclaw`. It now
stops before touching anything and points at `clawops gateway update` instead.

It also asks for confirmation. `--yes` was documented as skipping the prompt, but there was no
prompt: the migration simply ran. The question is the one `clawops_migrate` asks over MCP.
