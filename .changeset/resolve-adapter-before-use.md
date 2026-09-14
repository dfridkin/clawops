---
'@clawops/cli': patch
---

**`clawops plan` failed with "Provider not yet loaded. Call getStack() first."**

`buildContext().adapter` is a proxy that loads the provider module on its first *async* call.
Its synchronous methods — `normalizeInstanceType`, `defaultRegion`, `getConnectionInfo` —
throw until that has happened. `clawops up` works only because it happens to
`await validateConfig()` a few lines earlier; nothing says so, and nothing enforced it.

`generatePlan` needed the size table and no stack, so it called the proxy directly and the
plan died. `loadAdapterModule(provider)` is now exported for exactly this: callers that need a
synchronous adapter method without needing a stack await it, instead of depending on call
order. The proxy's error message names it.
