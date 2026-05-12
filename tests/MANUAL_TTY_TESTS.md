# Manual TTY Test Plan — Wave 8B (setup wizard, config overlay, macOS bootstrap)

These tests require a real terminal with an interactive TTY. They cannot be automated
because `inquirer` list/checkbox prompts require arrow keys.

Run from the project root: `cd /Users/admin/Dev/clawops`

## Prerequisites

```bash
# Run from source without publishing to npm
alias clawops-dev="pnpm dev"

# To test the local SSH path on macOS, enable Remote Login:
# System Settings → General → Sharing → Remote Login
```

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

**Goal:** Wizard produces a valid `openclaw-*.json` with `$secret:` refs and channels as an object (not array), then runs init + deploy automatically.

```bash
pnpm dev setup
```

| Prompt | Answer |
|---|---|
| Deployment type | **Local** |
| SSH host | `127.0.0.1` |
| SSH port | `22` |
| SSH user | your macOS username |
| SSH private key | `~/.ssh/id_rsa` |
| Stack name | `local-test` |
| OpenClaw version | `stable` |
| LLM provider | **OpenAI** |
| Model | **GPT-4o** |
| API key storage | **Environment variable** |
| Env var name | `OPENAI_API_KEY` |
| Connect to a chat app? | **Yes** |
| Connect Discord? | **Yes** |
| Discord token storage | **Environment variable** → `DISCORD_BOT_TOKEN` |
| Discord guild ID | `123456789` |
| Connect Telegram? | **Yes** |
| Telegram token storage | **Environment variable** → `TELEGRAM_BOT_TOKEN` |
| Connect Slack? | **No** |
| Connect WhatsApp? | **No** |
| Connect Teams? | **No** |
| Directory to save generated files | `/tmp` |
| Write MCP config to Claude config file? | **Yes** |
| Run init and deploy now? | **No** (first pass — verify file output only) |

**Verify:**

```bash
cat /tmp/openclaw-local-test.json
```

- [ ] `models.provider` = `"openai"`, `models.model` = `"gpt-4o"`
- [ ] `models.apiKey` = `"$secret:OPENAI_API_KEY"` (not the actual key value)
- [ ] `channels` is an **object**, not an array: `{ "discord": {...}, "telegram": {...} }`
- [ ] `channels.discord.token` = `"$secret:DISCORD_BOT_TOKEN"`
- [ ] Both Discord AND Telegram present (each confirmed via individual y/n prompt)
- [ ] MCP config written: `cat ~/Library/Application\ Support/Claude/claude_desktop_config.json | python3 -m json.tool`
  - should contain `"clawops": { "command": "clawops", "args": ["mcp", "serve", "--read-only"] }`

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
| OpenClaw version | `stable` |
| LLM provider | **Amazon Bedrock** |
| Model | **Claude Sonnet 4.6** |
| Set up integrations? | **No** |

**Verify:**

- [ ] No API key prompt appeared — wizard showed an IAM note instead
- [ ] `cat /tmp/openclaw-bedrock-test.json` has `models.provider = "bedrock"`
- [ ] `models.modelId` = `"anthropic.claude-sonnet-4-6"` (real Bedrock API ID, not a display name)
- [ ] No `apiKey` field present

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
| OpenClaw version | `stable` |
| LLM provider | **Ollama** |
| Model | **Llama 3.1** |
| Ollama base URL | `http://localhost:11434` (accept default) |
| Set up integrations? | **No** |

**Verify:**

- [ ] Wizard printed "Ollama model pull required" note with `ollama pull llama3.1` command
- [ ] `cat /tmp/openclaw-ollama-test.json` has `models.provider = "ollama"` and `models.baseUrl`
- [ ] No `apiKey` field

---

## Test 4 — Cloud provider, `--dry-run` → deploy plan output

**Goal:** Cloud path produces a valid deploy plan JSON without prompting to apply.

```bash
# Create a dummy SSH public key if needed
test -f ~/.ssh/id_rsa.pub || ssh-keygen -t ed25519 -f ~/.ssh/id_rsa -N "" -q

pnpm dev setup --dry-run --output-dir /tmp
```

| Prompt | Answer |
|---|---|
| Deployment type | **Cloud** |
| Provider | **AWS** |
| Stack name | `cloud-test` |
| Region | `us-east-1` (accept default) |
| Instance size | **small** |
| S3 bucket | `my-pulumi-state` |
| SSH public key path | `~/.ssh/id_rsa.pub` |
| Allowed SSH CIDR | `0.0.0.0/0` |
| OpenClaw version | `stable` |
| LLM provider | **Anthropic** |
| Model | **Claude Sonnet 4.6** |
| API key storage | **Environment variable** → `ANTHROPIC_API_KEY` |
| Set up integrations? | **No** |

**Verify:**

```bash
python3 -m json.tool /tmp/clawops-cloud-test-plan.json
```

- [ ] `spec.provider` = `"aws"`, `spec.stackName` = `"cloud-test"`
- [ ] `spec.openclaw.config.models.provider` = `"anthropic"`
- [ ] `spec.secrets` array contains `{ "name": "ANTHROPIC_API_KEY", "source": "env", "ref": "ANTHROPIC_API_KEY" }`
- [ ] `spec.ssh.publicKey` contains the actual key material (not a file path)
- [ ] No "Apply now?" prompt appeared (because `--dry-run` was set)

---

## Test 1b — Local provider, run init and deploy now

Re-run Test 1 with the same answers but answer **Yes** to "Run init and deploy now?".

**Verify:**

- [ ] Spinner shows "Bootstrapping host..." and completes
- [ ] Stack registered in `~/.clawops/config.json` automatically (no manual `clawops init` needed)
- [ ] Spinner shows "Applying config overlay..." and completes
- [ ] Gateway URL printed at end
- [ ] `pnpm dev status --stack local-test` shows the stack as running
- [ ] `pnpm dev doctor --stack local-test` reports no errors

---

## Test 5 — `clawops up --config` overlay (local provider, real SSH)

**Goal:** `--config` flag merges a JSON overlay into the remote `openclaw.json` and restarts the gateway.

Requires Remote Login enabled (or another SSH-reachable host).

```bash
# Register the stack
pnpm dev init \
  --provider local \
  --host 127.0.0.1 \
  --port 22 \
  --user $USER \
  --key ~/.ssh/id_rsa \
  --stack local-test

# Bootstrap host (installs Docker, starts OpenClaw container)
pnpm dev up --stack local-test

# Apply the config overlay from Test 1
pnpm dev up --stack local-test --config /tmp/openclaw-local-test.json
```

**Verify:**

```bash
# Read the config that was written to the host
pnpm dev ssh --stack local-test -- cat /home/clawops/openclaw.json

# Check the container is running and the stack is healthy
pnpm dev status --stack local-test
pnpm dev doctor --stack local-test
```

- [ ] `openclaw.json` on the host has `models.provider = "openai"` and `channels.discord`
- [ ] `channels` is an object (not array) on the remote host
- [ ] `status` shows a gateway URL and a running container
- [ ] `doctor` reports no errors

**macOS target note:** If the SSH target is this Mac, the config path is
`~/.config/openclaw/config.json` instead of `/home/clawops/openclaw.json`.

---

## Test 6 — `clawops config validate` catches bad configs

With a running local stack from Test 5:

```bash
# Should pass
pnpm dev config validate --stack local-test

# Manually break the config and validate again
pnpm dev ssh --stack local-test -- \
  "echo '{\"version\":\"2026.4\",\"channels\":[]}' > /home/clawops/openclaw.json"
pnpm dev config validate --stack local-test
```

- [ ] Clean config: `valid: true`, no issues
- [ ] Broken config: reports `"top-level 'version' is not a valid OpenClaw config key"` and `"channels must be an object"`

---

## Test 7 — macOS bootstrap Docker guard

**Goal:** Bootstrap exits with clear instructions when Docker is not running.

```bash
# Stop Docker Desktop or Colima if running, then:
pnpm dev up --stack local-test
```

- [ ] Bootstrap script prints Docker install options (Docker Desktop, Homebrew, Colima)
- [ ] Process exits non-zero with a clear message — does not hang

Restart Docker and re-run `pnpm dev up --stack local-test` to confirm it recovers cleanly.
