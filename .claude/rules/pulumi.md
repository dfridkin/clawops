---
description: Rules for Pulumi Automation API and component code
globs:
  - src/pulumi/**
---

# Pulumi rules

1. **Embedded engine only:** Use `LocalWorkspace` from `@pulumi/pulumi/automation`. Never shell out to the `pulumi` binary. No `pulumi.yaml` written to disk — programs are inline closures.

2. **pulumiHome sandboxed:** Always set `pulumiHome: path.join(configDir, '.pulumi')` to avoid clobbering the user's other Pulumi projects.

3. **No credentials in LocalWorkspace envVars (R6):** Credentials come from process environment, not from the `envVars` option.

4. **URN convention:** `clawops:<category>:<Name>`. Categories: `infra`, `build`, `net`, `app`, `state`.

5. **ComponentResource pattern:** All components extend `pulumi.ComponentResource`. Constructor: `(name, args, opts?)`. All inputs are `pulumi.Input<T>`. All public outputs are `pulumi.Output<T>`. Call `this.registerOutputs(...)` last.

6. **Pulumi mock tests:** Use `pulumi.runtime.setMocks()`. Type tags must be exact strings, e.g., `aws:ec2/instance:Instance` (NOT `aws:ec2:Instance`). Bug magnet — always verify against Pulumi docs.

7. **pnpm hoisting:** `@pulumi/pulumi` must be at workspace root. See `.npmrc` and ADR 0003.

8. **Output trimming (R14):** Never return raw Pulumi JSON output in MCP tool results. Summarise; expose full output as `clawops://stacks/{name}/last-run` resource. Hard cap: 8KB.
