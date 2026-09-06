# clawops Demo Script

This script walks through a full clawops session on a local VM. It is designed for evaluators,
screencasters, and contributors who want to see the complete workflow from install through teardown.

**What you need:**
- A Linux host reachable over SSH (local VM, Hetzner VPS, DigitalOcean Droplet, etc.)
- Node.js 22+ on your local machine
- An SSH key with access to the host

No cloud account required for this demo — the local provider bootstraps OpenClaw over SSH directly.

---

## 1. Install clawops

```bash
npm install -g @clawops/cli
clawops --version
# @clawops/cli 1.2.0
```

---

## 2. Check prerequisites

```bash
clawops doctor
```

```
clawops doctor
──────────────────────────────────────────
  Node.js version       ✓  v22.14.0
  Config directory      ✓  ~/.clawops/
  SSH key               ✓  ~/.clawops/id_ed25519
  Provider credentials  ✓  local (no cloud credentials required)
  Pulumi home           ✓  ~/.clawops/.pulumi/
──────────────────────────────────────────
All checks passed.
```

---

## 3. First-run wizard

`clawops setup` guides you through stack configuration, model/channel wiring, and MCP registration
in a single session. No manual JSON editing required.

```bash
clawops setup
```

The wizard prompts for:

| Step | Prompt | Example answer |
|---|---|---|
| 1 | Deployment target | `Local / existing Linux host` |
| 2 | Host address | `192.168.1.50` |
| 3 | SSH user | `ubuntu` |
| 4 | SSH key path | `~/.ssh/id_ed25519` (or auto-generate) |
| 5 | LLM provider | `Anthropic` |
| 6 | API key | *(enter your key)* |
| 7 | Model | `claude-opus-4-7` |
| 8 | Chat integrations | *(Space to toggle; Enter to confirm)* |
| 9 | AI editors to wire MCP | `Claude Code`, `Claude Desktop` |
| 10 | Deploy now? | `Yes` |

After confirming deploy, the wizard bootstraps the host:

```
  Bootstrapping local host 192.168.1.50...
  [1/4] Installing system packages...  ✓
  [2/4] Installing Docker...           ✓
  [3/4] Pulling OpenClaw image...      ✓
  [4/4] Starting OpenClaw service...   ✓

  ✓ OpenClaw is running at http://192.168.1.50:18789
    Gateway token: clawops-abc123def456

  Open your gateway dashboard:
    http://192.168.1.50:18789?token=clawops-abc123def456

  MCP config written to:
    ~/.claude.json (Claude Code)
    ~/Library/Application Support/Claude/claude_desktop_config.json (Claude Desktop)
```

---

## 4. Check stack status

```bash
clawops status
```

```
Stack: my-vm  Provider: local  Region: —

  IP address    192.168.1.50
  Gateway URL   http://192.168.1.50:18789
  SSH host      192.168.1.50:22  (user: ubuntu)
  Provisioned   2026-05-13T14:22:01Z

Container: running  Uptime: 2 minutes
```

---

## 5. Tail logs

```bash
clawops logs --tail 20
```

```
[openclaw] 2026-05-13T14:22:05Z  INFO   Gateway listening on :18789
[openclaw] 2026-05-13T14:22:05Z  INFO   Auth mode: token
[openclaw] 2026-05-13T14:22:06Z  INFO   Agent executor ready  agents=0
[openclaw] 2026-05-13T14:22:06Z  INFO   Model registry loaded  providers=1 models=1
```

Follow logs live:

```bash
clawops logs -f
# Ctrl-C to stop
```

---

## 6. Remote SSH commands

```bash
# Check running containers
clawops ssh --command "docker ps"
```

```
CONTAINER ID   IMAGE                                    STATUS
a3f1bc9e2d4a   ghcr.io/openclaw/openclaw:stable   Up 3 minutes
```

```bash
# Check disk usage
clawops ssh --command "df -h /"
```

```
Filesystem      Size  Used Avail Use% Mounted on
/dev/sda1        30G  4.2G   26G  14% /
```

---

## 7. Read and write config

```bash
# Read a single value
clawops config get gateway.port
# 18789

# List all config (JSON)
clawops config get --json | jq .

# Change max agent concurrency
clawops config set maxAgents 4
# ✓ Set maxAgents=4 on 192.168.1.50

# Verify
clawops config get maxAgents
# 4
```

---

## 8. Port-forward the gateway UI

No public port needed — access the gateway over an SSH tunnel:

```bash
clawops tunnel
# Forwarding localhost:18789 → 192.168.1.50:18789
# Press Ctrl-C to stop
```

Open `http://localhost:18789` in your browser (or `http://localhost:18789?token=YOUR_TOKEN`).

---

## 9. Use clawops from Claude Code (MCP)

Once `clawops mcp serve` is registered in `~/.claude.json` (the wizard does this automatically),
Claude Code can drive operations directly.

Example Claude Code session:

> **You:** Check the status of my clawops stack and tail the last 10 log lines.
>
> **Claude:** I'll check the stack status and recent logs.
>
> *[calls `clawops_status`]*
> Stack `my-vm` is running. IP: `192.168.1.50`, gateway: `http://192.168.1.50:18789`, uptime: 14 minutes.
>
> *[calls `clawops_logs_tail` with `lines: 10`]*
> Last 10 log lines: ... *(gateway activity, agent invocations)*

Start the MCP server manually for non-wizard setups:

```bash
# Read-only mode (safe for first evaluation)
clawops mcp serve --read-only

# Full mode (enables provisioning, config write, ssh exec)
clawops mcp serve
```

---

## 10. Create a backup

```bash
clawops backup create
```

```
✓ Backup created: ~/.clawops/backups/my-vm-2026-05-13T14-35-00Z.tar.gz
  Contents: openclaw.json, secrets/, known_hosts
  Size: 4.2 KB
```

Restoring is a manual procedure on this release line — OpenClaw `2026.7.1-2` has no `backup
restore` subcommand, so there is nothing to demo here beyond the archive itself. See
[Recovering from an archive](backup-restore.md#recovering-from-an-archive).

---

## 11. Restart services

```bash
# Restart the OpenClaw gateway
clawops gateway restart
# ✓ Gateway restarted on 192.168.1.50

# List agents
clawops agents list
# NAME        STATUS    UPTIME
# my-agent    running   12m

# Restart an agent
clawops agents restart my-agent
# ✓ Agent my-agent restarted
```

---

## 12. Tear down

```bash
# Destroy local stack (requires --yes)
clawops down --yes
```

```
Stopping OpenClaw on 192.168.1.50...
  Stopping container openclaw...  ✓
  Removing container openclaw...  ✓

Stack my-vm destroyed.
```

Config and backups are kept in `~/.clawops/`. Re-run `clawops setup` or `clawops up` to redeploy.

---

## Cloud provider demo (AWS)

The local path above requires no cloud account. For AWS, the workflow adds a plan/review step:

```bash
# AWS credentials must be in your environment
export AWS_PROFILE=my-profile

clawops init --provider aws
# Edit ~/.clawops/config.json — set stateUrl to your S3 bucket

# Generate a plan (dry-run safe)
clawops plan --provider aws --stack default --out /tmp/plan.json

# Review the plan
cat /tmp/plan.json | jq .diff

# Apply after review
clawops apply /tmp/plan.json

# Same day-to-day ops as local
clawops status
clawops logs -f
clawops ssh --command "docker ps"

# Destroy cloud resources
clawops destroy --yes
```

See [`docs/examples/local-vm.md`](examples/local-vm.md) for the full local walkthrough, and
[`docs/providers/matrix.md`](providers/matrix.md) for per-provider capability details.

---

## JSON output for scripting

Every command supports `--json` for structured output:

```bash
clawops status --json | jq .publicIp
# "192.168.1.50"

clawops agents list --json | jq '.[].status'
# "running"

clawops backup create --json | jq .path
# "/Users/you/.clawops/backups/my-vm-2026-05-13T14-35-00Z.tar.gz"
```

---

## What to look at next

- [`docs/examples/local-vm.md`](examples/local-vm.md) — full local VM walkthrough with troubleshooting
- [`docs/security/mcp-safety.md`](security/mcp-safety.md) — MCP safety model and tool risk matrix
- [`docs/plan-apply.md`](plan-apply.md) — plan/apply semantics for cloud providers
- [`docs/operations.md`](operations.md) — day-to-day operations reference
- [`README.md`](../README.md) — project overview and command reference
