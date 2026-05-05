# ADR 0004 — Configuration Precedence

**Status:** Accepted
**Date:** 2026-05-04
**Deciders:** Project author

## Context

clawops accepts configuration from four sources:

1. **Command-line flags** (`--region us-east-1`)
2. **Environment variables** (`CLAWOPS_REGION=us-east-1`, plus provider-native `AWS_REGION`)
3. **Config file** (`~/.clawops/config.json` per-stack values)
4. **Provider-native defaults** (e.g., AWS adapter's `defaultRegion()`)

When these conflict, behavior must be deterministic. Two common patterns exist in CLI tooling:

- **kubectl-style:** flag > env > config file > defaults (most permissive: closest-to-invocation wins)
- **Conservative:** config file > env > flag > defaults (least surprising: explicit project config wins)

## Decision

**Adopt kubectl-style precedence** for all config values:

```
flag > clawops env var > provider-native env var > config file > provider default
```

**Specifically:**

1. **CLI flag** (e.g., `--region us-west-2`) — highest priority
2. **clawops-namespaced env var** (e.g., `CLAWOPS_REGION=us-west-2`)
3. **Provider-native env var** (e.g., `AWS_REGION=us-west-2`)
4. **Config file value** for the active stack (e.g., `stacks.prod-aws.region`)
5. **Provider's `defaultRegion()`** method

**Exceptions to the rule:**

- **Credentials (R6):** ONLY env vars or provider-native CLI profiles are consulted. Flags and config file are forbidden from carrying credentials.
- **State backend URL:** ONLY config file (`stacks.<name>.stateUrl`). This is intentional — switching state backends mid-flight is a footgun.
- **Stack name:** flag (`--stack`) > `CLAWOPS_STACK` env var > config file `defaults.stack` > literal string `"default"`. (No provider default applies.)

## Resolution Order Implementation

```typescript
// src/config/resolve.ts (illustrative)
function resolveConfig<T>(opts: {
  flag?: T;
  envVars: string[];   // checked in order
  configKey?: string;
  default?: T | (() => T);
}): T | undefined {
  if (opts.flag !== undefined) return opts.flag;
  for (const v of opts.envVars) {
    if (process.env[v] !== undefined) return process.env[v] as T;
  }
  if (opts.configKey) {
    const v = lookupConfig(opts.configKey);
    if (v !== undefined) return v;
  }
  if (typeof opts.default === 'function') return (opts.default as () => T)();
  return opts.default;
}
```

## Consequences

**Positive:**
- Predictable, well-known precedence (`kubectl`, `helm`, `terraform`, `flyctl` all use this)
- Easy to override for one-off invocations without editing config
- Natural composition with shell scripts: `CLAWOPS_STACK=staging clawops up`
- CI-friendly: env-only deployment paths work cleanly

**Negative:**
- Slightly more error-prone than conservative precedence — a user with a `~/.clawops/config.json` value can be surprised by a leftover env var
- Mitigation: `clawops doctor` reports the resolved value AND its source for every key

## Verification

- `tests/config/precedence.test.ts` covers all 5 layers with all permutations
- `clawops doctor --verbose` shows resolved value + source for each config key (e.g., `region: us-east-1 (from CLAWOPS_REGION)`)
- Documentation in `docs/configuration.md` shows the precedence table prominently
