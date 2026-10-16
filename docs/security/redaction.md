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
| `key` | `apiKey`, `awsKey`, `key` |
| `password` | `password`, `adminPassword` |
| `connectionstring` | `connectionString`, `dbConnectionString` |
| `authorization` | `authorization` (HTTP header forwarded as arg) |
| `credential` | `GOOGLE_APPLICATION_CREDENTIALS`, `credentialsFile` (added after 2.2.1; it was in the spec and not enforced) |

This list must cover every pattern in `spec/errors.yaml → redaction.patterns`;
`tests/spec/errors.test.ts` fails if it does not.

## Exempt keys

Keys whose names (case-insensitive) contain the following are **not** redacted even
if they also match a sensitive pattern:

| Exempt pattern | Rationale |
|---|---|
| `keyname` | AWS key pair name: a label, not a secret |
| `keypath` | File path to an SSH private key, the path is not the key |
| `privatekeypath` | Same rationale as keypath |
| `knownhostspath` | Path to known_hosts file: not sensitive |

## Config paths and values

The config tools (`clawops_config_get`, `clawops_config_set`, `clawops_config_unset`) take `key`
as a dotted path into `openclaw.json`. A path is not a secret, so it is logged as written.
Whether `value` is redacted depends on the path, not on the argument's name:

- **Path names a secret.** If any segment of the path matches a pattern above (and is not
  exempt), the whole value is redacted. Examples: `models.providers.openai.apiKey`,
  `gateway.auth.token`.
- **Value is a JSON object.** A value such as `channels.telegram '{"botToken":"..."}'` is
  sanitised field by field, using the same rules as a top-level argument object.
- **Anything else** is logged as written.

`clawops_config_set`'s confirmation prompt applies the same redaction.

**Before 2.3.1** these values were matched by argument name. The path was redacted, because
`key` matches the `key` pattern, and the value was logged in clear. An audit log written by an
earlier version may contain config values set through MCP. Check it, and rotate any secret you
find there.

## ARN replacement

AWS ARN strings in argument values are replaced with `arn:aws:***:<region>:<account>:***` to reduce
log noise. The pattern matched is `arn:aws:[a-z0-9\-*]+:[a-z0-9\-]*:[0-9]*:[^\s,'"]+`.

## Array sanitisation

Arguments that are arrays are sanitised recursively: each object element in the array is processed
the same as a top-level argument object. Scalar elements (strings, numbers) are passed through
unchanged unless their containing key matches a sensitive pattern.

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
