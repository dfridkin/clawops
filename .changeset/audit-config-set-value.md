---
"@clawops/cli": patch
---

Security: `clawops_config_set` no longer writes the value it sets to the MCP audit log in clear. Values are now redacted when their config path names a secret (for example `models.providers.openai.apiKey`), and secret fields inside a JSON object value are redacted individually. The config path is logged as written; before this fix the path was redacted and the value was not. The confirmation prompt applies the same redaction. Existing audit logs are not rewritten, so if you set a secret through `clawops_config_set` before this release, check `~/.clawops/mcp-audit.log` and rotate that secret.
