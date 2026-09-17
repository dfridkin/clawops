---
'@clawops/cli': patch
---

`clawops doctor --provider aws` checks the account a deploy would land in: the account the
credentials resolve to, the state bucket, and whether the instance type is offered in the
region. It offers to create the bucket when it is genuinely absent, with versioning on and
public access blocked.

A check clawops could not perform — a denied listing — reports as a warning naming the error,
rather than as a pass or a failure. Azure's VM size check uses the same state.
