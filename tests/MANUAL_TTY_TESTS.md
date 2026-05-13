# Manual TTY Test Plan — Wave 8B (setup wizard, config overlay, macOS bootstrap)

These tests require a real terminal with an interactive TTY. They cannot be automated
because `inquirer` list/checkbox prompts require arrow keys and spacebar input.

Run from the project root: `cd /Users/admin/Dev/clawops`

## Prerequisites

```bash
# Run from source without publishing to npm
alias clawops-dev="pnpm dev"

# To test the local SSH path on macOS, enable Remote Login:
# System Settings → General → Sharing → Remote Login
```

**Checkbox navigation (applies to integration and MCP steps):**
- `↑` / `↓` — move between options
- `Space` — toggle selection on/off
- `Enter` — confirm and continue

---

## Smoke check (no SSH needed)

Confirm all commands load without crashing before running deeper tests.

```bash
for cmd in setup up down status plan apply config doctor mcp; do
  pnpm dev $cmd --help > /dev/null && echo "OK: $cmd" || echo "FAIL: $cmd"
done
```

Expected: `OK: <cmd>` for every command.

---

## Test 1 — Local provider, full wizard → config overlay output

**Goal:** Wizard produces a valid `openclaw-*.json` with `$secret:` refs, channels as an object, and all secrets resolved at deploy time.

```bash
pnpm dev setup
```

| Prompt | Answer |
|---|---|
| Deployment type | **Local** |
| SSH host | `127.0.0.1` |
| SSH port | `22` (Enter) |
| SSH user | your macOS username (pre-filled) |
| SSH private key | `~/.ssh/id_ed25519` (or detected key) |
| Stack name | `local-test` |
| OpenClaw version | `latest` (Enter) |
| LLM provider | **Anthropic** |
| Model | **Claude Sonnet 4.6** |
| API key storage | **Paste it here** → paste a real or dummy key |
| Integrations | Space to select **Discord** and **Telegram**, Enter |
| Discord bot token | **Paste it here** → paste a token |
| Telegram bot token | **Paste it here** → paste a token |
| AI app integration | Space to select **Claude Desktop** (if shown), Enter |
| Deploy now? | **No** (first pass — verify file output only) |

**Verify:**

```bash
cat ./openclaw-local-test.json
```

- [ ] `models.provider` = `"anthropic"`, `models.model` starts with `"claude-"`
- [ ] `models.apiKey` = `"$secret:ANTHROPIC_API_KEY"` (unresolved ref in the saved file)
- [ ] `channels` is an **object**, not an array: `{ "discord": {...}, "telegram": {...} }`
- [ ] `channels.discord.botToken` = `"$secret:OPENCLAW_DISCORD_TOKEN"`
- [ ] `gateway.auth.mode` = `"token"` and `gateway.auth.token` is a 48-char hex string
- [ ] MCP config written (if Claude Desktop was selected):
  ```bash
  cat ~/Library/Application\ Support/Claude/claude_desktop_config.json | python3 -m json.tool
  ```
  - `command` should be an absolute path to the clawops binary (not just `"clawops"`)

---

## Test 1b — Local provider, deploy now (full end-to-end)

Re-run Test 1 with the same answers but answer **Yes** to "Initialize and deploy the server now?".

**Verify:**

- [ ] Keyboard hint line printed before integration and MCP checkboxes: `ℹ Use ↑↓ to move, Space to select/deselect, Enter to confirm.`
- [ ] Bootstrap spinner advances through stage labels as the script runs
- [ ] Spinner completes with "OpenClaw installed on 127.0.0.1"
- [ ] Stack registered in `~/.clawops/config.json`
- [ ] "Applying your configuration..." spinner completes
- [ ] Final output shows a tokenized dashboard URL:
  ```
  ✔ All done! OpenClaw is running.
  ℹ Open dashboard: http://127.0.0.1:18789?token=<48-char-hex>
  ℹ   (or enter the token manually in the "Gateway Token" field: <token>)
  ```
- [ ] Token file written to `~/.clawops/secrets/GATEWAY_TOKEN_local-test`
- [ ] Gateway accessible: `curl -s http://127.0.0.1:18789/health`
- [ ] Gateway portal connects when the tokenized URL is opened in a browser
- [ ] Process exits cleanly (no hang after "Run clawops doctor" message)
- [ ] `pnpm dev doctor --stack local-test` reports no errors

---

## Test 2 — Local provider, Bedrock (no API key prompt)

**Goal:** Bedrock path shows an IAM note instead of prompting for an API key.

```bash
pnpm dev setup --output-dir /tmp
```

| Prompt | Answer |
|---|---|
| Deployment type | **Local** |
| SSH host/port/user/key | anything |
| Stack name | `bedrock-test` |
| OpenClaw version | `latest` (Enter) |
| LLM provider | **Amazon Bedrock** |
| Model | any |
| Integrations | Enter (none) |
| Deploy now? | **No** |

**Verify:**

- [ ] No API key prompt appeared — wizard showed an IAM note instead
- [ ] `cat /tmp/openclaw-bedrock-test.json` has `models.provider = "bedrock"`
- [ ] `models.modelId` is a real Bedrock API ID (e.g. `"anthropic.claude-sonnet-4-6"`)
- [ ] No `apiKey` field in the models section

---

## Test 3 — Local provider, Ollama (base URL prompt + pull note)

**Goal:** Ollama path prompts for base URL and prints a post-setup pull command.

```bash
pnpm dev setup --output-dir /tmp
```

| Prompt | Answer |
|---|---|
| Deployment type | **Local** |
| SSH host/port/user/key | anything |
| Stack name | `ollama-test` |
| OpenClaw version | `latest` (Enter) |
| LLM provider | **Ollama** |
| Model | any Ollama model |
| Ollama address | `http://localhost:11434` (Enter) |
| Integrations | Enter (none) |
| Deploy now? | **No** |

**Verify:**

- [ ] No API key prompt appeared — wizard prompted for Ollama base URL only
- [ ] `/tmp/openclaw-ollama-test.json` has `models.provider = "ollama"` and `models.baseUrl`
- [ ] Post-setup note shows the `ollama pull <model>` command

---

## Test 4 — Cloud provider, dry run (plan file output)

**Goal:** Cloud path produces a valid `clawops-*.json` deploy plan with `spec.secrets` array.

```bash
pnpm dev setup --dry-run --output-dir /tmp
```

| Prompt | Answer |
|---|---|
| Deployment type | **Cloud** |
| Provider | **AWS** |
| AWS auth check | confirm authenticated or skip |
| Stack name | `cloud-test` |
| Region | `us-east-1` (Enter) |
| Instance size | **small** |
| S3 bucket | `my-test-bucket` |
| SSH public key | `~/.ssh/id_ed25519.pub` |
| SSH CIDR | `0.0.0.0/0` (Enter) |
| OpenClaw version | `latest` (Enter) |
| LLM provider | **Anthropic** |
| Model | **Claude Sonnet 4.6** |
| API key storage | **Environment variable** → `ANTHROPIC_API_KEY` |
| Integrations | Enter (none) |

**Verify:**

```bash
cat /tmp/clawops-cloud-test-plan.json
```

- [ ] `spec.provider` = `"aws"`, `spec.region` = `"us-east-1"`
- [ ] `spec.openclaw.config.models.provider` = `"anthropic"`
- [ ] `spec.openclaw.config.gateway.auth.token` is a 48-char hex string
- [ ] `spec.secrets` array contains `{ "name": "ANTHROPIC_API_KEY", "source": "env", "ref": "ANTHROPIC_API_KEY" }`
- [ ] `spec.ssh.publicKey` contains actual key material (not a file path)
- [ ] No "Deploy now?" prompt appeared (because `--dry-run` was set)

---

## Test 1b-secrets — Secrets are resolved at deploy time

After a successful Test 1b deploy, verify the remote config has resolved API key values:

```bash
ssh -i ~/.ssh/id_ed25519 admin@127.0.0.1 cat ~/.config/openclaw/config.json
```

- [ ] `models.apiKey` contains the real API key value (not `"$secret:ANTHROPIC_API_KEY"`)
- [ ] `channels.discord.botToken` contains the real token (not `"$secret:..."`)
- [ ] `gateway.auth.token` matches the token in `~/.clawops/secrets/GATEWAY_TOKEN_local-test`

---

## Test 5 — `clawops up --config` overlay (local provider, real SSH)

**Goal:** `--config` flag merges a JSON overlay into the remote `openclaw.json` and restarts the gateway.

```bash
pnpm dev init \
  --provider local \
  --host 127.0.0.1 \
  --port 22 \
  --user $USER \
  --key ~/.ssh/id_ed25519 \
  --stack local-test

pnpm dev up --stack local-test
pnpm dev up --stack local-test --config ./openclaw-local-test.json
```

**Verify:**

```bash
pnpm dev status --stack local-test
pnpm dev doctor --stack local-test
```

- [ ] `openclaw.json` on the host has `models.provider = "anthropic"` and `channels.discord`
- [ ] `channels` is an object (not array) on the remote host
- [ ] `status` shows a gateway URL and a running container
- [ ] `doctor` reports no errors

---

## Test 6 — `clawops config validate` catches bad configs

With a running local stack:

```bash
pnpm dev config validate --stack local-test

pnpm dev ssh --stack local-test -- \
  "echo '{\"version\":\"2026.4\",\"channels\":[]}' > ~/.config/openclaw/config.json"
pnpm dev config validate --stack local-test
```

- [ ] Clean config: `valid: true`, no issues
- [ ] Broken config: reports version key error and `channels must be an object`

---

## Test 7 — macOS bootstrap Docker guard

**Goal:** When Docker is not running on the remote host, the wizard starts it via SSH rather than failing.

Simulate by stopping Docker on a remote Linux host (or by using a VM), then run the wizard pointed at that host.

- [ ] Wizard detects `NOT_RUNNING` on the remote and attempts `sudo systemctl start docker` via SSH
- [ ] Polls until Docker responds (up to 90s), then continues bootstrap
- [ ] If Docker cannot be started, surfaces a clear message: "Start Docker manually and re-run: clawops setup"

**Localhost path (macOS):** stopping Docker Desktop locally should still trigger the interactive "How would you like to start Docker?" prompt (Docker Desktop / Colima / systemctl choices).
