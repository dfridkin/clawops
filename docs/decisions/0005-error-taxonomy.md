# ADR 0005 — Error Taxonomy and Exit Codes

**Status:** Accepted
**Date:** 2026-05-04
**Deciders:** Project author

## Context

PRD §5.6 specifies four exit codes (1, 2, 3, 4) and the SPEC mentions `ProviderError` subclasses, but neither maps the relationship between error *types* in code and the exit code surfaced to the shell or the audit log entry.

For a tool that can be driven by humans, scripts, CI, and AI agents, the error taxonomy is a contract. Vague errors break agent decision-making (the agent can't tell "transient cloud quota issue, retry" from "user supplied bad credentials, abort"). Vague exit codes break CI (operators can't write `if [ $? -eq 4 ]; then ...` reliably).

## Decision

### Exit Code Mapping

| Code | Class | Meaning | Examples |
|---|---|---|---|
| **0** | Success | Operation completed | normal completion |
| **1** | OperationalError | Cloud or runtime error during a valid operation | API timeout, instance failed to boot |
| **2** | UsageError | User input is invalid | bad flag, missing required arg |
| **3** | AuthError | Credentials missing, invalid, or insufficient | no AWS_PROFILE, expired token |
| **4** | StateError | clawops-managed state is corrupt or inconsistent | stack lock held, plan signature mismatch |
| **5** | ProviderError | Cloud provider rejected the request for non-auth reasons | quota exceeded, region unsupported |
| **6** | NetworkError | Network connectivity failure | DNS, connect timeout, TLS |
| **130** | Cancelled | User sent SIGINT / cancellation request | Ctrl+C, MCP cancellation notification |

(130 is convention for SIGINT termination; we keep it.)

### Error Class Hierarchy

```typescript
// src/errors/index.ts
export class ClawopsError extends Error {
  abstract readonly exitCode: number;
  abstract readonly errorClass: string;  // matches taxonomy IDs below
  abstract readonly retryable: boolean;
  abstract readonly userActionRequired: boolean;
  // structured context for audit logs
  readonly context: Record<string, unknown>;
}

export class UsageError extends ClawopsError { exitCode = 2; ... }
export class AuthError extends ClawopsError { exitCode = 3; ... }
export class StateError extends ClawopsError { exitCode = 4; ... }
export class ProviderError extends ClawopsError { exitCode = 5; ... }  // base
export class NetworkError extends ClawopsError { exitCode = 6; ... }
export class OperationalError extends ClawopsError { exitCode = 1; ... }
export class CancelledError extends ClawopsError { exitCode = 130; ... }

// Provider-specific subclasses
export class AwsCredentialsError extends AuthError { /* ... */ }
export class AwsQuotaError extends ProviderError { /* ... */ }
export class GcpQuotaError extends ProviderError { /* ... */ }
export class AzureSubscriptionError extends AuthError { /* ... */ }
```

### Error Taxonomy IDs

Every error has a stable `errorClass` string for machine identification (audit logs, agent decision-making, CI scripting):

| ID | Class | Notes |
|---|---|---|
| `usage.invalid_flag` | UsageError | bad flag value |
| `usage.missing_arg` | UsageError | required arg not provided |
| `usage.invalid_path` | UsageError | non-absolute path where R7 requires absolute |
| `auth.no_credentials` | AuthError | no env var, no profile, no metadata |
| `auth.expired` | AuthError | token expired |
| `auth.insufficient_permissions` | AuthError | IAM action denied |
| `state.lock_held` | StateError | another clawops instance is operating on this stack |
| `state.signature_mismatch` | StateError | plan was tampered with |
| `state.backend_unreachable` | StateError | can't read/write state blob |
| `provider.quota_exceeded` | ProviderError | retryable after backoff |
| `provider.region_unsupported` | ProviderError | not retryable; user must change region |
| `provider.api_rate_limited` | ProviderError | retryable with backoff |
| `provider.resource_not_found` | ProviderError | depends on context |
| `network.timeout` | NetworkError | retryable |
| `network.dns_failure` | NetworkError | usually retryable |
| `network.tls_failure` | NetworkError | usually NOT retryable (cert issue) |
| `op.timeout` | OperationalError | operation didn't complete in expected time |
| `op.unexpected_state` | OperationalError | cloud resource in unexpected state |
| `op.cancelled` | CancelledError | user-initiated cancel |

### MCP Tool Error Surface

When an MCP tool handler throws a `ClawopsError`:

```typescript
{
  isError: true,
  content: [{
    type: "text",
    text: "<human-readable message>"
  }],
  // structured fields per MCP error spec
  structuredError: {
    errorClass: "auth.no_credentials",
    retryable: false,
    userActionRequired: true,
    suggestedAction: "Run `clawops init` to configure credentials.",
    docsUrl: "https://clawops.dev/docs/auth"
  }
}
```

This gives agents enough context to decide: retry, ask user, or abort.

### Audit Log Integration

`src/mcp/audit.ts` includes the error taxonomy fields in every failed-call entry:

```json
{
  "ts": "2026-05-01T12:34:56.789Z",
  "tool": "clawops_up",
  "result": "error",
  "error": {
    "errorClass": "provider.quota_exceeded",
    "exitCode": 5,
    "retryable": true,
    "context": { "provider": "aws", "region": "us-east-1", "service": "ec2" }
  }
}
```

## Consequences

**Positive:**
- Predictable exit codes for CI/scripting
- Agents can make informed retry/abort decisions
- Audit logs are queryable by error class
- Adding a new error type is mechanical (subclass + taxonomy ID + test)

**Negative:**
- More upfront design discipline; engineers can't just `throw new Error(...)` ad-hoc
- Mitigation: lint rule `clawops/no-raw-error` flags any `throw new Error(...)` outside of `src/errors/`; also `Result<T, E>` pattern preferred internally per CLAUDE.md style guide

## Verification

- `tests/errors/taxonomy.test.ts` asserts every taxonomy ID maps to exactly one error class
- ESLint rule prevents raw `throw new Error()` in `src/` (must use `ClawopsError` subclass)
- `clawops --help` documents exit codes
- All MCP tools' error responses include `structuredError`
