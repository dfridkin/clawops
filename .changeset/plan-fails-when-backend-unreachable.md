---
'@clawops/cli': patch
---

**`clawops plan` wrote a plan even when its state backend did not exist.**

Opening the stack and previewing it failed into the same `catch`, which wrote a warning and
carried on. A missing S3 bucket produced:

```
error: could not list bucket: NoSuchBucket: The specified bucket does not exist
✔ Plan generated
✓ Plan written to /tmp/plan.json
```

and exit 0. `doctor` said the provider was fine, `plan` said the plan was fine, and `apply` then
failed with a raw Pulumi error naming a bucket clawops had never mentioned.

A backend that cannot be opened now ends the command and names the cause — not Pulumi's `code:
-2` wrapper, which is what the first line of its error actually says. A preview that fails on a
stack which opened normally still writes the plan without a diff, as before.
