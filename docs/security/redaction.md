# Audit Log Redaction

clawops redacts sensitive values before writing them to the audit log. This page
documents exactly which fields are redacted and which are not.

## Redacted keys

Any argument key whose name (case-insensitive) contains one of the following
substrings has its value replaced with `"[REDACTED]"`:

| Pattern | Example keys |
|---|---|
| `token` | `gatewayToken`, `botToken`, `token` |
| `secret` | `secretValue`, `apiSecret` |
| `password` | `password`, `adminPassword` |
| `connectionstring` | `connectionString`, `dbConnectionString` |
| `authorization` | `authorization` (HTTP header forwarded as arg) |

## Exempt keys

Keys whose names (case-insensitive) contain the following are **not** redacted even
if they also match a sensitive pattern:

| Exempt pattern | Rationale |
|---|---|
| `keyname` | AWS key pair name — a label, not a secret |
| `keypath` | File path to an SSH private key — the path is not the key |
| `privatekeypath` | Same rationale as keypath |
| `knownhostspath` | Path to known_hosts file — not sensitive |

## ARN replacement

AWS ARN strings in argument values are replaced with `[ARN]` to reduce log noise.
The pattern matched is `arn:aws:[a-z0-9:-]+`.

## What is logged

Each entry is a single line of NDJSON:

```json
{
  "ts": "2026-05-07T14:23:01.456Z",
  "sessionId": "a1b2c3d4",
  "tool": "clawops_config_set",
  "args": { "key": "gateway.auth.token", "value": "[REDACTED]" },
  "durationMs": 42,
  "result": "ok"
}
```

`sessionId` is generated once per server process (not per connection). This lets
you correlate all calls from a single agent session.

## What is NOT redacted

- SSH hostname / IP address
- Port numbers
- Stack names
- Provider names (aws, gcp, azure, local)
- File paths (other than key paths, which are exempt rather than redacted)
- `clawops_status` and `clawops_stacks_list` output summaries

If you store IP addresses or hostnames that you consider sensitive, be aware that
they appear in the log.

## Where logs are stored

Default path: `~/.clawops/mcp-audit.log`

Configurable via `~/.clawops/config.json → mcp.auditLogPath`.

The server also writes each entry to `stderr`. In stdio mode the host application
(Claude Desktop, Cursor, etc.) captures this stream.

See [audit-logs.md](audit-logs.md) for how to read and rotate audit logs.
