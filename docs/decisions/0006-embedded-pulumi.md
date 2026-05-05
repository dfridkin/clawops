# ADR 0006 — Embedded Pulumi Automation API (Not User-Installed Pulumi CLI)

**Status:** Accepted
**Date:** 2026-05-04
**Deciders:** Project author

## Context

clawops needs to manage cloud infrastructure with a real IaC tool underneath. Three options:

1. **Direct cloud SDKs** (`@aws-sdk`, etc.) — no IaC, we'd reimplement state, drift, ordering
2. **Shell out to Pulumi CLI** (require user to `brew install pulumi`)
3. **Embed Pulumi Automation API** (Pulumi engine as a TypeScript library)

## Decision

**Embed the Pulumi Automation API.** Bundle the engine as a library dependency; no user-installed Pulumi binary required.

## Rationale

### vs. Direct SDKs

Pulumi gives us state management, diff/preview, drift detection, dependency ordering, and resource graph parallelism out of the box. Re-implementing these for AWS + GCP + Azure + local would be ~6 months of engineering with bugs we'd discover the hard way. The `@pulumi/aws`, `@pulumi/gcp`, `@pulumi/azure-native` provider packages are typed, maintained, and battle-tested.

### vs. Shell-out to Pulumi CLI

Embedding wins on:

- **Install friction:** `npm i -g clawops` is one step. Forcing users to also install Pulumi CLI is a second step that loses ~30% of users at any install boundary.
- **Process model:** Embedded means in-process state, no subprocess management, no JSON-over-stdout parsing.
- **Error fidelity:** Pulumi engine errors come through as TypeScript exceptions with structured context, not stderr text we'd have to parse.
- **Deterministic version:** We pin `@pulumi/pulumi` to a specific version. Shelling out means the user's `pulumi` could be any version, breaking compatibility silently.
- **Inline programs:** No `pulumi.yaml` written to disk; programs are TypeScript closures. Cleaner repo state, no orphaned project directories.

Embedding loses on:

- **Bundle size:** The Pulumi engine is ~50MB. clawops's npm package balloons accordingly.
- **Cold-start latency:** Engine init is ~500ms. Less than the cost of any real operation.
- **Pulumi user familiarity:** Users who already know Pulumi might want to use their installed version. Mitigation: we expose `clawops state export` so users can pull state into their own Pulumi setup if they want to migrate.

## Implementation Sketch

```typescript
// src/pulumi/automation.ts
import { LocalWorkspace } from '@pulumi/pulumi/automation';

export async function getOrCreateStack(opts: StackOpts) {
  return await LocalWorkspace.createOrSelectStack(
    {
      stackName: opts.stack,
      projectName: 'clawops',
      program: opts.program,  // inline closure from ProviderAdapter
    },
    {
      workDir: undefined,                   // no on-disk project
      pulumiHome: opts.pulumiHome,          // sandboxed under ~/.clawops/.pulumi
      envVars: {
        PULUMI_BACKEND_URL: opts.stateUrl,  // configured during clawops init
      },
    }
  );
}
```

## Consequences

**Positive:**
- One-command install
- Tightly-controlled Pulumi version
- Cleaner integration boundary (TypeScript ↔ TypeScript)
- No subprocess JSON parsing

**Negative:**
- ~50MB install size
- pnpm hoisting interaction (handled in ADR 0003)
- Users with existing Pulumi setups don't share state automatically (mitigated by `clawops state export`)

## Verification

- `npm i -g clawops` succeeds without any Pulumi CLI installed
- `which pulumi` returns nothing on a clean machine, but `clawops up` succeeds
- The Pulumi version reported by `clawops version --verbose` matches our pinned dep
