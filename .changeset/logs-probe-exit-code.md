---
'@clawops/cli': patch
---

**`clawops logs` never read from the gateway on AWS.**

The probe deciding whether the gateway can serve its own logs was:

```bash
docker exec openclaw openclaw logs --limit 1 >/dev/null 2>&1 && echo ok || echo no
```

It discards stderr and exits 0 whatever happened, so `execPrivileged` — which tests the exit
code before deciding a command was refused Docker access — never escalated to `sudo`. On AWS the
SSH user is `ubuntu`, who is not in the docker group, so `docker exec` was always refused, the
probe could only answer "no", and `logs` silently read container output instead.

GCP and Azure connect as `clawops`, who is in the group, so this was invisible until the first
AWS deploy. The probe reports through its exit code now, and keeps stderr, which is what says
why it failed.
