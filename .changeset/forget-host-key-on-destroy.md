---
'@clawops/cli': patch
---

`clawops destroy` forgets the instance's host key, so deploying onto an address the cloud has
recycled no longer fails host-key verification.
