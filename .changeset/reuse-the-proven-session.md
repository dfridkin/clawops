---
'@clawops/cli': patch
---

**A deploy could fail one line after reporting SSH was up.**

```
Waiting for 100.56.120.109:22 to accept SSH — a new instance takes a minute.
SSH is up after 2 attempts.
✖ Deployment failed
  SSH connection failed: Timed out while waiting for handshake
```

The readiness wait proved the host was accepting SSH, closed that session, and `apply` then
opened a second one for the gateway wait — a fresh handshake against a host that had started
accepting connections moments earlier, with no retries behind it. The wait retried; the
connection immediately after it did not.

`waitForSsh` hands back the session it proved with, and the gateway wait uses that. One
connection instead of two, and no unguarded handshake in between.
