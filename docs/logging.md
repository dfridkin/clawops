# Logging Specification

This document specifies clawops's logging behavior in implementation detail. ADR 0007 chose pino as the library; this doc fills in what fields, levels, and formatters are used where.

## Log Streams

clawops has TWO logical log streams:

1. **Application log** — operational events, debug info, errors
2. **Audit log** — structured per-tool-call records (MCP-only)

Both use pino under the hood. Both write to stderr by default. They are distinguished by a `stream` field.

## Application Log

### Format

JSON to stderr in all non-TTY contexts. Pretty-printed to stderr in TTY (when `process.stderr.isTTY && !process.env.CI && !mcpStdioMode`).

```json
{
  "level": "info",
  "time": 1714838096789,
  "stream": "app",
  "module": "provider",
  "msg": "Provisioning EC2 instance",
  "stackName": "prod",
  "provider": "aws",
  "region": "us-east-1"
}
```

### Levels

| Level | When to use |
|---|---|
| `trace` | Extremely verbose; per-line subprocess output |
| `debug` | Operation step-through; useful for development |
| `info` | Significant events: command start/end, resource created, etc. |
| `warn` | Recoverable issues: retry happening, deprecated input |
| `error` | Operation failed but caller still in control |
| `fatal` | Process about to exit; unrecoverable |

Default level: `info` in production, `debug` when `NODE_ENV !== 'production'`. Override via `CLAWOPS_LOG_LEVEL`.

### Required Fields

Always present (pino defaults + clawops additions):

| Field | Type | Source |
|---|---|---|
| `level` | string | pino |
| `time` | number (ms) | pino |
| `pid` | number | pino |
| `hostname` | string | pino |
| `stream` | string | clawops (always `"app"` for application log) |
| `module` | string | clawops sub-logger context |
| `msg` | string | logger call |

### Contextual Fields (when relevant)

| Field | When |
|---|---|
| `stackName` | Stack-scoped operation |
| `provider` | Provider-scoped operation |
| `region` | Cloud-region-aware operation |
| `command` | CLI command being executed |
| `errorClass` | When `level === 'error'` (per ADR 0005) |
| `durationMs` | On completion of timed operation |
| `traceId`, `spanId` | When OTel enabled (per docs/telemetry.md) |
| `requestId` | MCP request correlation |
| `sessionId` | MCP session correlation |

### Sub-loggers

Create child loggers per module so `module` is auto-populated:

```typescript
// src/logging/index.ts
export const logger = pino(/* config */);
export const cliLogger = logger.child({ module: 'cli' });
export const providerLogger = logger.child({ module: 'provider' });
export const pulumiLogger = logger.child({ module: 'pulumi' });
export const mcpLogger = logger.child({ module: 'mcp' });
export const sshLogger = logger.child({ module: 'ssh' });
export const planLogger = logger.child({ module: 'plan' });
```

### Provider sub-sub-loggers

Within a provider:

```typescript
const log = providerLogger.child({ provider: 'aws' });
log.info({ stackName, region }, 'Provisioning EC2 instance');
```

## Audit Log

### Purpose

Per R21: every MCP tool call writes a structured audit entry. This is operational forensics for security and debugging — separate stream, stricter schema.

### Format

JSON to stderr OR to the path configured at `mcp.auditLogPath` in `~/.clawops/config.json`.

```json
{
  "level": "info",
  "time": 1714838096789,
  "stream": "audit",
  "sessionId": "01HXY...ULID",
  "tool": "clawops_up",
  "toolset": "cli",
  "args": {
    "stackName": "prod",
    "provider": "aws",
    "region": "us-east-1"
  },
  "durationMs": 142000,
  "result": "ok",
  "resourceCount": 7,
  "msg": "tool_call"
}
```

### Required Fields

| Field | Type | Notes |
|---|---|---|
| `stream` | string | always `"audit"` |
| `time` | number | Unix ms |
| `sessionId` | string (ULID) | per MCP session |
| `tool` | string | tool name (e.g., `clawops_up`) |
| `toolset` | string | toolset assignment from `mcp-tools.yaml` |
| `args` | object | sanitized per redaction patterns |
| `durationMs` | number | tool handler execution time |
| `result` | string | `"ok"` \| `"error"` \| `"cancelled"` |

### Conditional Fields

| Field | When |
|---|---|
| `error` | When `result === 'error'`; `{ errorClass, exitCode, message }` |
| `taskId` | When tool returned a task ID for async polling |
| `resourceCount` | Provisioning operations (created/destroyed count) |
| `progressMaxValue` | When `notifications/progress` was emitted |

### Implementation

`src/mcp/audit.ts`:

```typescript
import { mcpLogger } from '../logging/index.js';

const auditLogger = mcpLogger.child({ stream: 'audit' });

export const audit = {
  toolCall(entry: ToolCallAuditEntry) {
    auditLogger.info(sanitize(entry), 'tool_call');
  },
};

function sanitize(entry: ToolCallAuditEntry): ToolCallAuditEntry {
  // Apply patterns from spec/errors.yaml redaction.patterns
  // ...
}
```

## MCP stdio mode (R15 critical)

When the MCP server runs in stdio mode:

- **No writes to stdout from any logger.** Period. Stdout is owned by the JSON-RPC protocol.
- Pino is configured with `pino.destination(2)` (stderr fd) explicitly
- `pino-pretty` is DISABLED in stdio mode (it might still target stderr correctly, but we play it safe)
- `console.log` is forbidden by ESLint everywhere except `src/output/`

If a contributor adds a stray `console.log`, the lint rule catches it AND `tests/mcp/stdio-purity.test.ts` (I7) catches it at runtime.

## OpenTelemetry Integration

When `OTEL_EXPORTER_OTLP_ENDPOINT` is set, the OTel pino instrumentation auto-attaches `traceId` and `spanId` to log records. No additional configuration needed. See `docs/telemetry.md`.

## Sensitive Field Redaction

Pino's `redact` config strips known-sensitive keys at log time. The pattern list comes from `spec/errors.yaml` `redaction.patterns`:

```typescript
{
  redact: {
    paths: spec.redaction.patterns,
    censor: spec.redaction.censor,  // "***"
  },
}
```

The audit logger applies an additional layer of sanitization for nested objects (full ARN replacement, IP partial-redaction in some contexts).

## Sampling and Rate Limiting

Not implemented in v1. If logs become a noise problem:

- Add pino's built-in level filtering tightening (e.g., default `warn` in prod)
- Add per-event rate limiting via custom transport (v1.1+)

## Rotation

clawops doesn't manage log files (it writes to stderr). Users redirecting to a file should use logrotate or equivalent.

## Testing

- `tests/logging/output.test.ts` — JSON shape, pretty mode toggling
- `tests/logging/redaction.test.ts` — sensitive fields censored
- `tests/mcp/audit-sanitization.test.ts` — audit logger redaction
- `tests/mcp/stdio-purity.test.ts` — no stdout writes in stdio mode (I7)

## Examples

### Successful operation

```json
{"level":"info","time":1714838000000,"stream":"app","module":"cli","msg":"Starting clawops up","command":"up","stackName":"prod"}
{"level":"info","time":1714838000010,"stream":"app","module":"provider","provider":"aws","msg":"Validating credentials"}
{"level":"info","time":1714838000050,"stream":"app","module":"pulumi","msg":"Stack selected","stackName":"prod"}
{"level":"info","time":1714838142000,"stream":"app","module":"cli","msg":"Stack updated","durationMs":142000}
{"level":"info","time":1714838142005,"stream":"audit","sessionId":"01HXY...","tool":"clawops_cli_up","args":{"stackName":"prod"},"durationMs":142000,"result":"ok","msg":"tool_call"}
```

### Error path

```json
{"level":"error","time":1714838010500,"stream":"app","module":"provider","provider":"aws","msg":"Quota exceeded","errorClass":"provider.quota_exceeded","durationMs":10500}
{"level":"info","time":1714838010505,"stream":"audit","sessionId":"01HXY...","tool":"clawops_cli_up","result":"error","error":{"errorClass":"provider.quota_exceeded","exitCode":5},"durationMs":10500,"msg":"tool_call"}
```
