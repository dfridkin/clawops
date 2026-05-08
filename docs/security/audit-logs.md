# Audit Logs

Every clawops MCP tool call is logged to an append-only NDJSON file. This log is
the primary record for reviewing what an AI agent did to your infrastructure.

## Log location

Default: `~/.clawops/mcp-audit.log`

Override in `~/.clawops/config.json`:

```json
{
  "mcp": {
    "auditLogPath": "/var/log/clawops/audit.log"
  }
}
```

The server also writes every entry to `stderr`. In stdio mode the host application
captures this stream; in HTTP mode it goes to the terminal where you started the
server.

## Log format

One JSON object per line (NDJSON):

```json
{"ts":"2026-05-07T14:23:01.456Z","sessionId":"a1b2c3d4","tool":"clawops_status","args":{},"durationMs":38,"result":"ok"}
{"ts":"2026-05-07T14:23:05.122Z","sessionId":"a1b2c3d4","tool":"clawops_config_set","args":{"key":"gateway.auth.token","value":"[REDACTED]"},"durationMs":51,"result":"ok"}
{"ts":"2026-05-07T14:23:09.800Z","sessionId":"a1b2c3d4","tool":"clawops_destroy","args":{"stack":"my-stack","yes":true},"durationMs":4201,"result":"ok"}
```

| Field | Type | Description |
|---|---|---|
| `ts` | ISO 8601 | Wall-clock time when the call completed |
| `sessionId` | 8-char hex | One ID per server process; correlates calls from a single agent session |
| `tool` | string | MCP tool name |
| `args` | object | Sanitised tool arguments (see [redaction.md](redaction.md)) |
| `durationMs` | number | Elapsed time from tool entry to response |
| `result` | `"ok"` \| `"error"` | Whether the tool returned successfully |
| `error` | string? | Present only when `result` is `"error"` |

## Reading the log

Print the last 50 entries:
```bash
tail -50 ~/.clawops/mcp-audit.log
```

Pretty-print the last 10 entries:
```bash
tail -10 ~/.clawops/mcp-audit.log | jq .
```

Show only destructive tool calls:
```bash
jq 'select(.tool | test("up|destroy|apply|config_set|restart|deploy"))' \
  ~/.clawops/mcp-audit.log
```

Show all calls in a specific session:
```bash
jq 'select(.sessionId == "a1b2c3d4")' ~/.clawops/mcp-audit.log
```

Show errors only:
```bash
jq 'select(.result == "error")' ~/.clawops/mcp-audit.log
```

## Log rotation

The server appends to the log file and never rotates it. For production use,
configure an external rotation tool.

**logrotate example** (`/etc/logrotate.d/clawops`):

```
/home/youruser/.clawops/mcp-audit.log {
    daily
    rotate 30
    compress
    missingok
    notifempty
    copytruncate
}
```

`copytruncate` is used instead of `postrotate`/`HUP` because the server holds the
file open and does not handle rotation signals.

## What is redacted

Sensitive argument values are replaced with `[REDACTED]` before writing. AWS ARN
strings are replaced with `[ARN]`. See [redaction.md](redaction.md) for the full
list of redacted and exempt keys.

The `result` field and error messages are **not** redacted. If an error message
from an underlying SDK happens to contain a secret, it will appear in the log.

## Security considerations

- The log file is written with the permissions of the process that runs the MCP
  server (typically your user account). Restrict access if the machine is shared.
- In CI/CD pipelines, redirect or suppress stderr if it might be captured in build
  logs that are publicly visible.
- `clawops config get` output is also **not** redacted in the tool response (only in
  the audit log args). Avoid calling it in environments where responses are logged.
  Redaction of tool responses is tracked in WO-15.
