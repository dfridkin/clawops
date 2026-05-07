# clawops

**clawops** is a provider-agnostic CLI for deploying and operating self-hosted [OpenClaw](https://github.com/openclaw/openclaw) instances across AWS, GCP, Azure, and local VMs. It uses the [Pulumi Automation API](https://www.pulumi.com/docs/using-pulumi/automation-api/) (embedded — no `pulumi` binary required) for idempotent infrastructure management and exposes every operation as both a CLI command and an [MCP](https://modelcontextprotocol.io/) tool, so Claude Code, Cursor, and other AI agents can drive deployments deterministically.

```bash
npm install -g clawops
clawops init --provider aws
clawops plan --out /tmp/my-plan.json   # generate + review
clawops apply /tmp/my-plan.json        # apply after review
clawops logs -f
```

---

## Why clawops?

Every existing OpenClaw deployment path is cloud-specific, Kubernetes-bound, or fully managed SaaS. No open-source tool unifies provisioning + lifecycle management + remote agent interaction across providers under a single CLI with first-class AI agent integration.

| Capability | clawops |
|---|---|
| AWS, GCP, Azure, local VM | ✓ |
| Idempotent infra via Pulumi (embedded) | ✓ |
| SSH transport (pure Node — no system `ssh`) | ✓ |
| MCP server (stdio + HTTP) | ✓ |
| Plan → review → apply discipline | ✓ |
| JSON output everywhere (`--json`) | ✓ |
| No credentials in config | ✓ |

---

## Quick Start

### Prerequisites

- **Node.js ≥ 22** (LTS)
- Cloud credentials available in the environment (see [Configuration](#configuration))

### Install

```bash
npm install -g clawops
# or without a global install:
npx clawops
```

### Provision on AWS

```bash
# Write ~/.clawops/config.json and generate an SSH key pair
clawops init --provider aws

# Edit ~/.clawops/config.json — set stateUrl to your S3 bucket:
#   "stateUrl": "s3://my-clawops-state"

# Generate a deploy plan (runs pulumi preview internally)
clawops plan --provider aws --stack default --out /tmp/plan.json

# Review the plan JSON, then apply
clawops apply /tmp/plan.json

# Or preview + apply in one step (no plan file needed)
clawops up
```

### Day-to-day operations

```bash
clawops status              # Show stack outputs: IP, gateway URL, SSH info
clawops logs -f             # Tail OpenClaw logs over SSH
clawops ssh                 # Open an interactive SSH session
clawops ssh --command "docker ps"

clawops config get maxAgents
clawops config set maxAgents 8

clawops tunnel              # Port-forward gateway UI to localhost

clawops down --yes          # Destroy all infrastructure
```

---

## Commands

| Command | Description |
|---|---|
| `init` | Interactive setup wizard — writes config, generates SSH key pair |
| `up` | Provision or update stack (`--dry-run` for preview) |
| `down` | Destroy local-provider stack (requires `--yes`; `--dry-run` shows current outputs) |
| `destroy` | Destroy cloud-provider stack with confirmation prompt (`--dry-run` shows current outputs) |
| `status` | Show stack outputs: IP, gateway URL, region, provisioned time |
| `plan` | Generate a Maker deploy-plan JSON artifact (dry-run safe) |
| `apply` | Apply a previously reviewed plan file (`--dry-run` validates and shows diff without applying) |
| `ssh` | Interactive SSH session or run a remote command |
| `logs` | Stream OpenClaw logs (`-f`, `--tail N`, `--since 5m`) |
| `tunnel` | Local port-forward to gateway UI over SSH |
| `config` | Get/set remote OpenClaw config values (`--dry-run` shows would-write JSON) |
| `agents` | List or restart OpenClaw agents |
| `gateway` | Restart the OpenClaw gateway service |
| `backup` | Create or restore an OpenClaw state backup |
| `stacks` | List named stacks and their state |
| `doctor` | Check Node version, config, SSH key, provider credentials, and Pulumi home |
| `mcp` | Start the embedded MCP server (`mcp serve`) |

Full flag reference: `clawops <command> --help`

---

## Plan → Apply workflow

For non-local providers, clawops enforces a review-before-apply discipline:

```bash
# 1. Generate a plan — runs `pulumi preview` internally, produces JSON
clawops plan --provider aws --region us-east-1 --out /tmp/plan.json

# 2. Review plan.json — it shows exactly which resources will change
cat /tmp/plan.json | jq .diff

# 3. Apply — reads and validates the plan file, then runs `pulumi up`
clawops apply /tmp/plan.json

# Without --yes, apply prompts: "Continue? (y/N)"
clawops apply /tmp/plan.json --yes    # skip prompt in automation
```

The plan JSON conforms to `spec/deploy-plan.schema.json` (AJV-validated). Plans are portable — generated on one machine, applied on another.

---

## MCP server

clawops ships an embedded [MCP](https://modelcontextprotocol.io/) server. Claude Code, Cursor, and any MCP-compatible agent can drive deployments without leaving the chat interface.

### Stdio mode (Claude Code / VS Code)

Add to your Claude Code MCP config (`~/.claude.json` or project `.mcp.json`):

```json
{
  "mcpServers": {
    "clawops": {
      "command": "clawops",
      "args": ["mcp", "serve"]
    }
  }
}
```

### HTTP mode (remote / multi-client)

```bash
clawops mcp serve --http --port 3333 --bind 127.0.0.1
# MCP HTTP server listening on 127.0.0.1:3333
```

Point your MCP client at `http://127.0.0.1:3333`.

### Available tools

| Tool | Toolset | Description |
|---|---|---|
| `clawops_up` | cli | Provision or update a stack |
| `clawops_status` | read | Show stack outputs |
| `clawops_logs_tail` | read | Tail OpenClaw logs |
| `clawops_ssh_exec` | cli | Run a command over SSH |
| `clawops_plan` | cli | Generate a deploy plan |
| `clawops_apply` | cli | Apply a plan file |
| `clawops_destroy` | cli | Destroy a stack (elicits confirmation) |
| `clawops_config_get` | read | Read a remote config value |
| `clawops_config_set` | cli | Write a remote config value |
| `clawops_agents_list` | read | List running agents |
| `clawops_stacks_list` | admin | List all stacks and their state |
| `clawops_task_status` | read | Poll a long-running task |
| `clawops_workflow_deploy_app` | workflow | End-to-end deploy: plan → confirm → apply → status |

Destructive tools require explicit confirmation (R19 elicitation) unless `yes: true` is passed.

---

## Configuration

Config lives at `~/.clawops/config.json` (override with `$CLAWOPS_HOME`).

```json
{
  "version": 1,
  "defaults": {
    "provider": "aws",
    "stack": "default"
  },
  "stacks": {
    "default": {
      "provider": "aws",
      "region": "us-east-1",
      "stateUrl": "s3://my-clawops-state"
    }
  },
  "ssh": {
    "keyPath": "~/.clawops/id_ed25519",
    "knownHostsPath": "~/.clawops/known_hosts"
  }
}
```

**Cloud credentials are never stored in config** — clawops reads them from the environment:

| Provider | Credential source |
|---|---|
| AWS | `AWS_PROFILE` or standard AWS credential chain (`~/.aws/credentials`) |
| GCP | `GOOGLE_APPLICATION_CREDENTIALS` or `gcloud auth application-default login` |
| Azure | `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` or `az login` |
| Local | SSH host + key configured in `stacks[name].localOpts` |

---

## Architecture

```
clawops
├── src/cli/          citty-based commands (one file per verb)
├── src/config/       ~/.clawops/config.json management
├── src/providers/    Cloud adapters (AWS, GCP, Azure, local)
│   ├── aws/          Pulumi inline program + ProviderAdapter
│   ├── gcp/
│   ├── azure/
│   └── local/        SSH bootstrap (no Pulumi)
├── src/pulumi/       Pulumi Automation API wrapper + output helpers
├── src/transport/    SSH client (ssh2) + connection pool + tunnels
├── src/mcp/          MCP server, tool handlers, progress tracking
├── src/plan/         Maker plan generation, AJV validation, apply
├── src/output/       ASCII table, spinner, JSON, human-readable output
├── src/errors/       Typed error hierarchy with exit codes
└── spec/             Machine-readable ground truth (JSON Schema, YAML)
```

Key design decisions:

- **Pulumi Automation API (embedded):** no `pulumi` binary required; Pulumi home is sandboxed to `~/.clawops/.pulumi`; stack programs are inline TypeScript closures
- **State in cloud blob storage:** GCS (`gs://`), S3 (`s3://`), Azure Blob — no local state files, no `pulumi.yaml`
- **SSH via `ssh2`:** never shells out to `/usr/bin/ssh`; TOFU host verification against `~/.clawops/known_hosts`; connection pool with 5-min idle TTL
- **Plan → apply discipline:** every non-local deployment goes through `generatePlan()` → review → `applyPlan()`; destructive changes always require human review of the plan JSON
- **MCP-first:** every CLI operation has a typed MCP tool; schemas generated from `spec/mcp-tools.yaml`; all destructive tools use R19 elicitation

See [`docs/architecture.md`](docs/architecture.md) for a full narrative, and [`docs/decisions/`](docs/decisions/) for ADRs.

---

## Development

### Setup

```bash
git clone https://github.com/dfridkin/clawops.git
cd clawops
# Node 22+ required; use nvm: nvm use
pnpm install
pnpm dev doctor        # verify toolchain
```

### Scripts

```bash
pnpm dev                   # run CLI from src/ via tsx
pnpm build                 # tsup → dist/
pnpm test                  # vitest (356 tests, ~2s)
pnpm test:changed          # vitest --changed (fast edit loop)
pnpm typecheck             # tsc --noEmit
pnpm lint                  # eslint src/ tests/ scripts/ (--max-warnings=0)
pnpm gen:schemas           # regenerate src/providers/types.ts + src/mcp/tools/_generated.ts
pnpm gen:schemas --check   # CI guard: committed generated files match spec
pnpm changeset             # record a release note before merging
```

### Project layout

| Path | Purpose |
|---|---|
| `spec/` | Machine-readable ground truth: JSON Schema, YAML. **Treat as source of truth.** |
| `SPEC.md` | Full technical specification (milestones, rules, schemas) |
| `DESIGN_RULES.md` | 25 normative rules (R1–R25) referenced throughout the codebase |
| `docs/architecture.md` | Narrative system overview |
| `docs/decisions/` | Architecture Decision Records |
| `.claude/skills/` | Invokable procedures: `/add-provider`, `/release`, `/tdd`, `/mcp-tool` |
| `.claude/rules/` | Path-scoped lint rules loaded by Claude Code |

### Code generation

Two files are generated from `spec/` and must not be hand-edited:

- `src/providers/types.ts` — `ProviderAdapter` interface from `spec/providers.schema.json`
- `src/mcp/tools/_generated.ts` — Zod schemas and type exports from `spec/mcp-tools.yaml`

Run `pnpm gen:schemas` after modifying either spec file. CI enforces this with `--check`.

### Adding a provider

Use the `/add-provider` skill in Claude Code, or follow [`src/providers/CLAUDE.md`](src/providers/CLAUDE.md). Every adapter must satisfy `ProviderAdapter` in `src/providers/types.ts` — do not relax the schema to fit the adapter.

### Adding an MCP tool

Use the `/mcp-tool` skill. The skill adds the tool to `spec/mcp-tools.yaml`, runs `pnpm gen:schemas`, creates the handler in `src/mcp/tools/<toolset>/<name>.ts`, and wires it into the registry. All four annotation hints (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) are required on every tool.

### Conventional commits

```
feat(scope): description
fix(scope): description
docs / refactor / chore / test / perf / ci
```

Use `pnpm changeset` to record a release note before merging a `feat` or `fix`.

---

## Milestones

| Milestone | Status | What ships |
|---|---|---|
| M0 — Scaffold | ✅ | Tooling, CI, stubs, generated types |
| M1 — GCP MVP | ✅ | `init` / `up` / `down` / `status` / `ssh` / `logs` on GCP |
| M2 — Remote Mgmt | ✅ | `tunnel`, `config`, `agents`, `gateway`; SSH connection pool |
| M3 — AWS + Azure | ✅ | AWS EC2 + Azure VM adapters; `stacks list` |
| M4 — Local VM | ✅ | Local adapter (SSH bootstrap, no Pulumi); `doctor` |
| M5 — MCP Layer | ✅ | `mcp serve` (stdio), all CLI ops as MCP tools, progress tracking |
| M6 — Plan/Apply | ✅ | `plan` + `apply`; deploy-plan schema; MCP HTTP transport; `workflow_deploy_app` |
| M7 — v1.0 Polish | ✅ | Full `doctor` surface; `destroy` command; `--dry-run` on `up`/`down`/`destroy`/`apply`/`config`; `release.yml`; CI integration guide |

---

## License

MPL-2.0 — see [LICENSE](LICENSE).
