---
'@clawops/cli': patch
---

**`clawops gateway update` works.** Every update refused before touching anything, with "Could not
snapshot the state database before upgrading … EACCES during mkdir". The snapshot runs inside a
container, where the state directory is mounted at `/home/node/.openclaw`, and clawops handed it
the host's path instead, which does not exist in there and which the container's user cannot
create. The refusal was the safe outcome — the gateway kept running — but it meant no 2.x stack
could be updated by clawops at all, over the CLI or MCP. Unit tests answered the snapshot with
success whatever it was asked; a real host is what found it. The snapshot is now taken where the
container can write it, and the hint after a refused or failed update names it by its path on
the host.
