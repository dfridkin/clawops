---
'@clawops/cli': patch
---

`clawops plan` → `clawops apply` provisions a cloud stack and deploys OpenClaw onto it.

- Stack configuration is written once, by one writer shared between preview and apply.
- The plan records the public key that may log in, resolved from your configured key.
- clawops creates and stores the passphrase a self-managed state backend requires
  ([ADR 0011](https://github.com/dfridkin/clawops/blob/main/docs/decisions/0011-state-passphrase.md)).
