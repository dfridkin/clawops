---
'@clawops/cli': patch
---

**AWS had no account-level checks at all.**

GCP checks its project, APIs and state bucket; Azure checks its subscription, resource
providers, VM size and state credentials. AWS checked that a credential existed, so a first
deploy went:

```
clawops doctor --provider aws   → ✓ aws              (exit 0)
clawops plan  --provider aws    → ✔ Plan generated   (exit 0)
clawops apply plan.json         → error: NoSuchBucket …
```

`clawops doctor --provider aws` now names the account a deploy will land in, checks the state
bucket exists — offering to create it, with versioning on and public access blocked, when it is
genuinely absent rather than merely unreadable — and checks the instance type is offered in the
region.

**A check clawops could not perform now says so.** Preflight checks gained an `unknown` state:
reading instance-type offerings needs `ec2:DescribeInstanceTypeOfferings`, and without it the
check reports as a warning naming the error, instead of passing, failing the whole report, or
disappearing. Azure's size check, which reported a denied listing as a hard failure, uses it too.
