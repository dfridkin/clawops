---
'@clawops/cli': patch
---

**GCP instances boot with Secure Boot on.** `debian-12` supports it; left unset, GCP enables vTPM
and integrity monitoring and leaves Secure Boot off, which is what `clawops harden` reported on
every GCP stack. Existing stacks get this as an update, not a replacement: the machine stops,
the setting is applied, and it starts again with its boot disk and all OpenClaw state intact.

**A plan that would replace a resource said nothing about it.** Pulumi marks a replacement with
two characters and the plan parser matched only one, so a preview that would destroy the instance
and its boot disk summarised as "0 to create, 0 to update, 0 to delete". Replacements are counted
and listed now.

**`clawops plan` warns when a plan changes a deployment that already exists.** A replacement
names what is destroyed with it and points at `clawops backup create`; an instance update says
the gateway goes down and that disk state survives. A first deploy warns about nothing.
