# OpenClaw Configuration

clawops manages the **infrastructure** that OpenClaw runs on. Configuring OpenClaw itself — setting
up models, channels, agents, and gateway settings — is done through `clawops config` commands or
by editing `openclaw.json` on the remote host.

## Where the config lives

OpenClaw's config file is written to `/home/clawops/openclaw.json` on the target host during
bootstrap. The bootstrap creates a minimal default if the file doesn't already exist:

```json
{"version":"2026.4","gateway":{"port":18789,"auth":{"mode":"token"}},"models":{},"channels":[]}
```

clawops never overwrites an existing `openclaw.json` during re-bootstrap (`clawops up`).

## Managing config with clawops

### Read a value

```bash
clawops config get gateway.auth.token
clawops config get --json    # dump entire remote config as JSON
```

### Set a value

```bash
clawops config set gateway.auth.token "$(openssl rand -hex 32)"
clawops config set gateway.port 18789
```

After setting values that require a restart:

```bash
clawops gateway restart
```

Or pass `--restart` to apply and restart in one step:

```bash
clawops config set gateway.auth.token "$(openssl rand -hex 32)" --restart
```

### Dry-run before applying

```bash
clawops config set gateway.auth.token "newvalue" --dry-run
```

Prints the JSON that would be written without applying it. Useful for verifying complex nested
values.

> **Config validation is planned for a future release (WO-14).** Until then, clawops cannot
> validate your config before applying it. Syntax errors in `openclaw.json` will cause the gateway
> to fail to start — check with `clawops logs --tail 30` after a config change.

## Config file format

The `openclaw.json` config format is defined by OpenClaw, not clawops. clawops only manages
delivery and patching of the file. Always verify field names against the OpenClaw documentation
for your version.

### Top-level structure

```json
{
  "version": "2026.4",
  "gateway": { ... },
  "models": { ... },
  "channels": [ ... ]
}
```

| Field | Type | Description |
|---|---|---|
| `version` | string | Config schema version — must match your OpenClaw release |
| `gateway` | object | Gateway server settings (port, auth) |
| `models` | object | Model provider configurations (keyed by provider name) |
| `channels` | array | Channel integrations (Telegram, Discord, etc.) |

### Gateway settings

```json
{
  "gateway": {
    "port": 18789,
    "auth": {
      "mode": "token",
      "token": "YOUR_GATEWAY_TOKEN"
    }
  }
}
```

Generate a secure random token:
```bash
openssl rand -hex 32
```

**Never commit a real token to source control.** Pass it via an environment variable or secret
manager reference — see [Secret sources](#secret-sources) below.

### Models

Model provider configuration is version and provider-specific. Refer to the OpenClaw documentation
for your version to get exact field names. The `models` object is empty by default.

### Channels

Channel configuration is provider-specific. Each entry in the `channels` array needs at minimum a
`type` and provider-specific credentials. Refer to the OpenClaw documentation for exact field names.

## Example configs

Ready-to-use starting points are in [`examples/configs/`](../examples/configs/). Replace every
`YOUR_*` placeholder with a real value before applying.

| File | Description |
|---|---|
| `openclaw.basic.json` | Minimal gateway config — no model or channel |
| `openclaw.telegram.example.json` | Basic config with a Telegram bot channel |
| `openclaw.discord.example.json` | Basic config with a Discord bot channel |

### How to apply an example config

1. Copy the example to your working directory:
   ```bash
   cp examples/configs/openclaw.basic.json /tmp/my-openclaw.json
   ```

2. Edit `/tmp/my-openclaw.json` — replace all `YOUR_*` placeholders with real values.

3. Write the config to the remote host using `clawops config set` for individual fields:
   ```bash
   clawops config set gateway.auth.token "your-real-token"
   ```

   Or for a full config replacement, SSH in and write the file directly:
   ```bash
   clawops ssh --command "cat > /home/clawops/openclaw.json" < /tmp/my-openclaw.json
   ```

4. Restart the gateway:
   ```bash
   clawops gateway restart
   ```

5. Verify the gateway is healthy:
   ```bash
   clawops status
   clawops logs --tail 20
   ```

## Secret sources

**Do not put real tokens directly in `openclaw.json` if you can avoid it.** Prefer:

| Approach | How |
|---|---|
| Generate at deploy time | `openssl rand -hex 32` piped to `clawops config set` |
| Environment variable on host | Set in systemd `EnvironmentFile` and reference in config |
| Cloud secret manager | AWS SSM / GCP Secret Manager / Azure Key Vault — retrieve at startup |
| clawops secrets (planned) | WO-15 will add centralized secret redaction and WO-16 a config wizard |

The `clawops config get` output is **not** redacted by default in the current release — avoid
running it in environments where logs are collected. Redaction is tracked in WO-15.

## Editing config directly over SSH

For complex edits not easily expressed as `clawops config set` calls:

```bash
# Open the config in vim on the remote host
clawops ssh --command "sudo -u clawops vim /home/clawops/openclaw.json"

# Or pull the config locally, edit, then push back
clawops ssh --command "cat /home/clawops/openclaw.json" > /tmp/openclaw.json
# edit /tmp/openclaw.json
clawops ssh --command "sudo tee /home/clawops/openclaw.json" < /tmp/openclaw.json
clawops gateway restart
```

## Verifying config changes

```bash
# Check the gateway accepted the new config (look for startup errors)
clawops logs --tail 30

# Check current running config
clawops config get --json

# Check gateway is healthy
clawops status
```

If the gateway fails to start after a config change, the most common causes are:
- Syntax error in `openclaw.json` — run `clawops ssh --command "python3 -m json.tool /home/clawops/openclaw.json"` to check
- Unknown field name — verify against your OpenClaw version's documentation
- Missing required field — check `clawops logs --tail 50` for the specific error
