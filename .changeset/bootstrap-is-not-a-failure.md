---
'@clawops/cli': patch
---

**A host still installing Docker is not a failed deploy.**

The previous release in this series taught clawops to stop conflating "there is no container"
with "clawops could not ask". Its first real use raised:

```
Could not ask the host about the openclaw container: bash: line 1: docker: command not found.
```

which was accurate and the wrong response. A fresh VM has no Docker for the first minute or so —
the bootstrap installs it — so that is the deployment working, not failing.

The readiness wait now distinguishes a host that is still coming up (`command not found`, the
daemon not yet running) from one that will not answer (a socket that refuses this session, which
`sudo` has already failed to get past). It waits through the first and stops on the second, and
a timeout reports whichever kept happening.
