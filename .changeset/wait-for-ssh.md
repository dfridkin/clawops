---
'@clawops/cli': patch
---

**`clawops apply` reported success while the instance was still booting.**

Pulumi returns as soon as the cloud API accepts the resource; `sshd` starts a good half-minute
later. apply printed its success line, the gateway URL and the public IP at that moment, and
every command run after it failed:

```
✗  Connection   SSH connection failed: connect ECONNREFUSED 34.70.45.162:22
```

So did apply's own config-overlay step, which connects immediately after `stack.up` — any plan
carrying `openclaw.config` raced the boot. Nothing in clawops waited for anything.

apply now waits for the host to accept SSH before reporting success, saying so once if the wait
is more than momentary. `ECONNREFUSED` and handshake timeouts are expected in the first minute
of a VM's life and are retried; a host-key mismatch or an unreadable key is raised immediately,
because waiting will not fix it.
