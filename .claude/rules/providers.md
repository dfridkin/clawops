---
description: Rules for provider adapter code
globs:
  - src/providers/**
---

# Provider adapter rules

1. **Interface compliance (R-meta-1):** Every adapter must satisfy `ProviderAdapter` in `src/providers/types.ts` AND the JSON Schema in `spec/providers.schema.json`. Do not loosen the schema to accommodate an adapter; fix the adapter.

2. **No credentials in code (R6):** All credential reads go through `process.env`. Never put tokens, keys, or secrets in source files or config. Reference cloud CLI profiles (AWS_PROFILE, gcloud ADC, AZURE_CLIENT_ID).

3. **validateConfig() returns, not throws:** Return `{ ok: false, errors: [...] }` on startup failure; throw only at the CLI boundary.

4. **State backend scheme:** Must match `spec/providers.schema.json → stateBackend.scheme` enum value.

5. **Pulumi URN convention:** `clawops:<category>:<Name>` — categories: infra, build, net, app, state.

6. **Deny-all default security groups (N10):** Never default SSH or gateway ports to `0.0.0.0/0`. Require explicit CIDR in the deploy plan.

7. **AbortSignal on all async ops (R13):** Thread `signal?: AbortSignal` through every Pulumi Automation API call and SSH operation.

8. **Result<T, E> pattern:** Provider adapters return `Result` types; they do not throw. The CLI command handler is the throw boundary.
