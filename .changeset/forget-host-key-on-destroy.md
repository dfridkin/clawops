---
'@clawops/cli': patch
---

**Redeploying onto a recycled cloud address failed host-key verification.**

A cloud hands addresses back out. Destroy a stack, deploy another, and the new instance can
land on the address the old one just released — with a different host key:

```
ERROR  SSH to 136.116.28.199:22 failed for a reason waiting will not fix:
       Host denied (verification failed)
```

Trust-on-first-use refused, correctly, over a machine that no longer existed.

clawops creates these hosts and destroys them, so at the moment it destroys one, that host's
pinned key is stale by construction. `clawops destroy` now forgets it. Every other entry, every
comment and the rest of the file are left alone — `ssh.knownHostsPath` may be your own
`~/.ssh/known_hosts`.

When a mismatch does happen, the error names the file and gives the exact `ssh-keygen -R` line,
and still says that an address changing hands unexpectedly is the one case where you should not
clear it.
