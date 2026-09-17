---
'@clawops/cli': patch
---

`clawops plan` takes `--ssh-cidr`, `--gateway-cidr` and `--publish-gateway` to say who may
connect. `auto` resolves this machine's address while the plan is written, and a plan that
admits nothing says so.
