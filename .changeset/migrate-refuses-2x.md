---
'@clawops/cli': patch
---

**`clawops migrate` refuses a stack that is already on 2.x, and asks before it runs.** On a 2.x
stack it would have taken a backup, stopped the gateway, and replaced a working config with the
minimal one it synthesises for 1.x, because both lines name their container `openclaw`. It now
stops before touching anything and points at `clawops gateway update` instead.

It also asks for confirmation. `--yes` was documented as skipping the prompt, but there was no
prompt: the migration simply ran. The question is the one `clawops_migrate` asks over MCP.

It also pulls the 2.x image before stopping 1.x. The pull used to happen inside the start, after
the old gateway was down, so the downtime included downloading several gigabytes, and on a
local-provider host the startup check could time out mid-download and report a migration that
was still in progress as failed. A pull that fails now refuses before anything is stopped.
