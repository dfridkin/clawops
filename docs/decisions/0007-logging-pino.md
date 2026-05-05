# ADR 0007 — Logging Library and Format

**Status:** Accepted
**Date:** 2026-05-04
**Deciders:** Project author

## Context

N18 requires "structured JSON logs to stderr in all modes." R15 forbids stdout writes from MCP servers in stdio mode (anything not protocol-compliant corrupts the stream). N19 mentions optional OpenTelemetry trace export.

We need a logging library that:
- Emits JSON to stderr by default
- Supports structured fields (not just string templates)
- Has level filtering (`debug`, `info`, `warn`, `error`)
- Integrates with OpenTelemetry
- Is fast (logging is in the hot path of every operation)
- Has TypeScript types
- Doesn't pull in massive transitive dependencies

## Decision

**Use `pino`.**

Specifically:
- `pino` for the core logger
- `pino-pretty` ONLY in interactive CLI mode (when `process.stdout.isTTY && !process.env.CI && !mcpStdioMode`)
- Stderr destination always (R15 compliance)
- OTel integration via `@opentelemetry/instrumentation-pino`

## Rationale

### Why pino over alternatives

- **vs. winston:** pino is ~5x faster in benchmarks, has better TypeScript types, simpler API
- **vs. bunyan:** pino is the spiritual successor; bunyan is largely unmaintained
- **vs. native console + JSON.stringify:** no level filtering, no child loggers, no OTel integration
- **vs. consola:** great for CLIs but JSON output is not its primary mode; we need JSON-first
- **vs. log4js:** Java idioms imported into Node; over-featured for our use

### Configuration

```typescript
// src/logging/index.ts (illustrative)
import pino from 'pino';

const isTty = process.stderr.isTTY && !process.env.CI;
const isMcpStdio = process.env.CLAWOPS_MCP_TRANSPORT === 'stdio';

export const logger = pino({
  level: process.env.CLAWOPS_LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  // Always JSON in MCP stdio mode (no pretty-print)
  // Pretty-print only in interactive TTY
  transport: (isTty && !isMcpStdio)
    ? { target: 'pino-pretty', options: { destination: 2 /* stderr */ } }
    : undefined,
}, pino.destination(2));  // 2 = stderr fd

// Sub-loggers per module
export const providerLogger = logger.child({ module: 'provider' });
export const mcpLogger = logger.child({ module: 'mcp' });
export const pulumiLogger = logger.child({ module: 'pulumi' });
```

### Required Fields in Every Log Entry

| Field | Type | Notes |
|---|---|---|
| `level` | string | "debug" / "info" / "warn" / "error" / "fatal" |
| `time` | number | Unix ms (pino default) |
| `module` | string | Sub-logger context |
| `pid` | number | Process ID (pino default) |
| `hostname` | string | (pino default) |

### Optional Per-Operation Fields

| Field | When |
|---|---|
| `stackName` | Any operation on a stack |
| `provider` | Any provider-scoped operation |
| `region` | Cloud-region-aware operation |
| `sessionId` | MCP server context |
| `toolName` | MCP tool invocation |
| `taskId` | Long-running task tracking |
| `errorClass` | Failure path (per ADR 0005) |
| `durationMs` | Completion of any operation |
| `traceId`, `spanId` | OTel context (when enabled) |

### Sensitive Field Redaction

`pino` supports `redact` config for safe logging. Configure with:

```typescript
{
  redact: {
    paths: [
      'authorization',
      '*.authorization',
      'token',
      '*.token',
      'password',
      '*.password',
      'secret',
      '*.secret',
      'connectionString',
      '*.connectionString',
      'aws_access_key_id',
      '*.aws_access_key_id',
      'aws_secret_access_key',
      '*.aws_secret_access_key',
    ],
    censor: '***',
  },
}
```

This is in addition to the explicit sanitization in `src/mcp/audit.ts` per R21.

### Audit Log vs. Application Log

Two distinct log streams:

1. **Application log** (`logger` from above) — operational events, errors, debug info. Can be verbose.
2. **Audit log** (`src/mcp/audit.ts`) — structured per-tool-call records. Always written, separate stream, narrowly scoped fields.

The audit log uses pino under the hood but with a stricter schema and stricter redaction (R21).

## Consequences

**Positive:**
- Fast, structured, well-typed
- TTY-friendly in dev, JSON-friendly in CI/MCP
- OTel-ready
- Built-in redaction for secrets

**Negative:**
- Adds `pino` and `pino-pretty` as deps (~200KB combined; acceptable)
- Yet another logger config in the ecosystem; new contributors must read this ADR

## Verification

- `tests/logging/output.test.ts` asserts JSON shape in stdio mode, pretty in TTY
- `tests/logging/redaction.test.ts` asserts sensitive fields are censored
- MCP server stdio mode produces zero non-protocol bytes on stdout (I7 invariant)
