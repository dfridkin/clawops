---
'@clawops/cli': patch
---

**`clawops setup` writes the cloud's own instance type into the plan it builds.** The wizard
wrote the clawops size (`small`) where the plan needs the provider's type (`t3.small`,
`e2-standard-2`, `Standard_B2s`), and the cloud programs pass that field to the cloud unchanged, so
a deploy from the wizard's plan asked the cloud for a machine type called `small`. It now maps the
size the same way `clawops plan` does.
