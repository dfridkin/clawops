# /openclaw-config

Generate or update an `openclaw.json` config for a deployed stack.

## Steps

1. **Read the OpenClaw version** from `spec/openclaw-versions.yaml` to check compatibility quirks.

2. **Generate `openclaw.json`** using the provider adapter's config template:
   - Model provider section (Bedrock, Anthropic API, etc.)
   - Channel configuration
   - Gateway auth mode

3. **Bedrock / AWS compatibility note:**
   OpenClaw 2026.4.5+ requires `AWS_PROFILE` in the systemd `EnvironmentFile=`,
   NOT `auth: "aws-sdk"` in `openclaw.json`. The AWS adapter must emit BOTH for
   backwards compatibility. See `spec/openclaw-versions.yaml`.

4. **Secrets** are always references (env var names, ARNs), never inline values. Per R6.

5. **Apply the config** via `clawops config set <key> <value>` or during `clawops up`.

## Output format

```json
{
  "version": "2026.4",
  "gateway": {
    "port": 18789,
    "auth": { "mode": "token" }
  },
  "models": {},
  "channels": {}
}
```
