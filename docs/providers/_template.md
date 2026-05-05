# <Provider Name> Provider

> **Replace this template with your provider's docs.** Use `docs/providers/aws.md` (when written) as the reference.

## Quick Start

```bash
# 1. Configure credentials (provider-specific; see "Credentials" below)
export <ENV_VAR>=<value>

# 2. Initialize clawops for this provider
clawops init --provider <name>

# 3. Deploy
clawops up --provider <name> --region <region>
```

## Credentials

How clawops sources credentials for `<provider>`:

- **Source**: `env` | `cli-profile` | `instance-metadata` | `file`
- **Env vars checked**: `<LIST>` (in priority order)
- **CLI profile**: `<details>` (if applicable)
- **Required permissions**: see [Required IAM/Roles](#required-iamroles)

### Per the credentials policy (R6, ADR 0004)

Credentials NEVER appear in:
- `~/.clawops/config.json` (only `credentialsRef`)
- CLI flags
- MCP tool arguments
- Audit logs (sanitized per `spec/errors.yaml`)

## Required IAM/Roles

Minimum permissions clawops needs:

| Action | Resource | Notes |
|---|---|---|
| `<api>:<verb>` | `<resource>` | <why> |

Example IAM/role policy: see `assets/templates/<name>/least-privilege.json`.

## Resources Created

When you run `clawops up --provider <name>`, the adapter provisions:

- **VM/Instance**: `<details>`
- **Network**: `<VPC, firewall, etc.>`
- **Public IP**: `<static or ephemeral>`
- **Identity**: `<service account, instance role, etc.>`
- **Secret store**: `<Secrets Manager, Key Vault, etc.>` for the gateway token
- **DNS** (optional): `<details>`

The exact resource graph is visible via `clawops plan --provider <name>`.

## Instance Type Aliases

| Alias | Native Type | vCPU | Memory | Arch |
|---|---|---|---|---|
| `micro` | `<native-id>` | 1 | 1 GB | x86_64 |
| `small` | `<native-id>` | 2 | 4 GB | x86_64 |
| `medium` | `<native-id>` | 4 | 16 GB | x86_64 |
| `large` | `<native-id>` | 8 | 32 GB | x86_64 |
| `gpu` | `<native-id>` | 4 | 16 GB | x86_64 + GPU |

## Region Defaults

- **Default**: `<region>`
- **Recommended for**: `<criteria>`
- **Supported regions**: see `clawops_provider_regions` MCP resource (`clawops://providers/<name>/regions`)

## State Backend

- **URL pattern**: `<scheme>://<bucket>/clawops`
- **Bootstrapping**: clawops `<creates|requires existing>` the bucket on first `init`
- **Encryption**: `<details>`

## OpenClaw Version Compatibility

See `spec/openclaw-versions.yaml` for the support matrix. Provider-specific quirks:

- `<quirk-id>`: `<description>` (workaround applied automatically)

## Cost Estimate

Approximate monthly cost for the default deployment:

- **Idle**: $`<X>`/month (instance always-on)
- **With auto-stop**: $`<Y>`/month (using `clawops scheduling` features — v1.1+)

These are estimates only; check your cloud bill.

## Troubleshooting

### Common issues

| Symptom | Likely cause | Fix |
|---|---|---|
| `auth.no_credentials` | Env var not set | `export <VAR>=...` |
| `auth.insufficient_permissions` | IAM role too narrow | See [Required IAM](#required-iamroles) |
| `provider.quota_exceeded` | Cloud quota | Request increase |

### Diagnostic commands

```bash
clawops doctor --provider <name>      # validates config + auth
clawops plan --provider <name>        # shows what would be created
clawops status --stack <name>         # current state
clawops logs --stack <name> --tail 100
```

## Known Limitations

- `<list any provider-specific feature gaps>`

## See Also

- ADR 0005 — error taxonomy
- `src/providers/<name>/` — implementation
- `tests/providers/<name>/` — test fixtures
