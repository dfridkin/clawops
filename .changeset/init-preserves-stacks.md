---
'@clawops/cli': patch
---

**Registering a second stack deleted the first.**

`clawops init` built a fresh config object with a single `stacks` entry and wrote it over
`~/.clawops/config.json`:

```bash
clawops init --provider gcp --stack staging --force
```

That dropped every other stack — and with it their `stateUrl`, the only pointer to where that
stack's Pulumi state lives. The infrastructure stayed up and clawops could no longer list,
reach or destroy it. There was no other way to register a second stack.

`init` is additive now: a stack that is not in the config is added, no `--force` required.
`--force` is needed to overwrite a stack that *is* there, since changing a registered
`stateUrl` orphans state just as thoroughly. Config outside `stacks` survives, and the default
moves to the stack just initialised.

Related: `clawops plan` for an unregistered stack emitted a plan with an empty `diff` and a
warning far up the output, then failed at `apply` — after the plan had been reviewed and
approved. The preview's catch swallowed the error that said so. A `UsageError` now fails the
plan; a genuine preview failure is still tolerated.
