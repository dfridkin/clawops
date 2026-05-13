# Secret Lifecycle

clawops stores secrets (API keys, gateway tokens, bot tokens) as local files in
`~/.clawops/secrets/` with `chmod 600`. Config overlays reference them as `$secret:<NAME>` — the
value is substituted at apply time and never written to the stack config on disk.

---

## Where secrets come from

Secrets enter clawops through the `setup` wizard or directly via `clawops secret set`. Three
source types are supported:

| Source | How it works |
|---|---|
| `paste` | You type the value; it is saved to `~/.clawops/secrets/<NAME>` (chmod 600) |
| `env` | The config overlay records the env var name; value is read at apply time from `process.env` |
| `file` | You point to an existing file on disk; the path is recorded in the overlay |

Cloud secret manager sources (`aws-sm`, `aws-ssm`, `gcp-sm`, `azure-kv`) are recognised in plan
files but are not yet resolved automatically — a warning is emitted and the ref is left in place
for manual handling.

---

## Commands

### `clawops secret list`

Show all secrets stored in `~/.clawops/secrets/`:

```
clawops secret list
```

```
Name                    Status   Modified    Path
──────────────────────  ───────  ──────────  ──────────────────────────────────────
ANTHROPIC_API_KEY       ok       2026-05-13  /Users/you/.clawops/secrets/ANTHROPIC_API_KEY
GATEWAY_TOKEN_prod      ok       2026-05-13  /Users/you/.clawops/secrets/GATEWAY_TOKEN_prod
OPENCLAW_DISCORD_TOKEN  empty    2026-05-10  /Users/you/.clawops/secrets/OPENCLAW_DISCORD_TOKEN
```

`--json` for structured output.

### `clawops secret set <name>`

Create or update a secret interactively:

```bash
clawops secret set ANTHROPIC_API_KEY
# Value for secret "ANTHROPIC_API_KEY": (input is hidden) ****
# ✓  Secret "ANTHROPIC_API_KEY" saved to ~/.clawops/secrets/ANTHROPIC_API_KEY  (chmod 600)
```

Pass `--value <val>` to skip the prompt (useful in scripts — prefer env vars over inline values).

After `set`, the secret file is updated but the running OpenClaw gateway is not yet aware of the
change. Use `clawops secret rotate` to propagate.

### `clawops secret rotate <name>`

Update a secret **and** re-apply the config overlay to a running stack:

```bash
clawops secret rotate ANTHROPIC_API_KEY
clawops secret rotate ANTHROPIC_API_KEY --stack prod
```

Rotate does three things:
1. Prompts for the new value and writes it to `~/.clawops/secrets/<NAME>`
2. Re-applies the stored config overlay (resolving all `$secret:` refs with current values)
3. Restarts the OpenClaw gateway on the target stack

The overlay is stored automatically by `clawops setup` and `clawops apply`. If no overlay is
stored for the stack, rotate updates the file and warns — you will need to re-run `setup` or
`apply` to propagate.

### `clawops secret delete <name>`

Remove a secret from `~/.clawops/secrets/`:

```bash
clawops secret delete OPENCLAW_DISCORD_TOKEN
```

clawops warns if the secret is still referenced in a stored stack overlay. Use `--yes` to skip the
confirmation prompt.

Deleting a secret does not update any running stack. If the stack is restarted or the overlay is
re-applied, the `$secret:` ref will fail to resolve.

### `clawops secret audit`

Scan all stored secrets and overlays for problems:

```bash
clawops secret audit
```

```
✗  2 issues found:

⚠  OPENCLAW_DISCORD_TOKEN: File exists but is empty: ~/.clawops/secrets/OPENCLAW_DISCORD_TOKEN
⚠  [prod] ANTHROPIC_API_KEY: File not found: ~/.clawops/secrets/ANTHROPIC_API_KEY

ℹ  Run `clawops secret set <name>` to update a missing or empty secret.
```

Audit checks:
- Every file in `~/.clawops/secrets/` is readable and non-empty
- Every secret ref in a stored stack overlay has a resolvable source (file exists, env var set)
- Cloud SM sources are flagged as needing manual handling

`--json` returns `{ issues: [...], ok: boolean }`.

---

## Rotation procedure

**Standard rotation (API key or bot token):**

```bash
# 1. Update the secret and re-apply in one step
clawops secret rotate ANTHROPIC_API_KEY --stack prod

# 2. Verify the stack is healthy
clawops status --stack prod
clawops logs --tail 20 --stack prod
```

**Gateway token rotation:**

```bash
clawops secret rotate GATEWAY_TOKEN_prod --stack prod
# Re-applies overlay and restarts gateway.
# Open the new dashboard URL printed by `clawops status`.
```

**Manual fallback** (if rotate's re-apply fails):

```bash
# 1. Update the secret file
clawops secret set MY_SECRET

# 2. Re-run the full apply
clawops apply /path/to/plan.json       # cloud stacks
# or
clawops setup                          # re-run wizard for local stacks
```

---

## Security notes

- Secret files are stored with `chmod 600` (owner read/write only).
- The `~/.clawops/secrets/` directory is `chmod 700`.
- Secret values are never written to `~/.clawops/config.json` or any plan file.
- Stored overlays (`~/.clawops/overlays/`) contain `$secret:<NAME>` refs, not resolved values —
  they are safe to back up alongside the config.
- `clawops secret list` and `clawops secret audit` never print secret values.

---

## What is not automated

- **Cloud secret manager rotation.** Secrets sourced from AWS Secrets Manager, GCP Secret Manager,
  or Azure Key Vault must be rotated in the cloud console. Update the version/alias as needed;
  clawops will re-read the ref at next apply.
- **SSH key rotation.** Managed separately via `ssh-keygen` and `clawops init --key-path`.
- **Pulumi state encryption keys.** Out of scope — managed by your Pulumi backend.

See [`docs/limitations.md`](limitations.md) for the full list of what clawops does not automate.
