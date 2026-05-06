# clawops

**clawops** is a provider-agnostic CLI for deploying and operating self-hosted [OpenClaw](https://github.com/openclaw/openclaw) instances across AWS, GCP, Azure, and local VMs. It uses the [Pulumi Automation API](https://www.pulumi.com/docs/using-pulumi/automation-api/) for idempotent infrastructure management and exposes every operation as both a CLI command and an [MCP](https://modelcontextprotocol.io/) tool — so Claude Code, Cursor, and other AI agents can drive deployments deterministically.

```
npm install -g clawops
clawops init --provider gcp
clawops up
clawops logs -f
```

---

## Why clawops?

Every existing OpenClaw deployment path is either cloud-specific, Kubernetes-bound, or a fully managed SaaS. No open-source tool unifies provisioning + lifecycle management + remote agent interaction across providers under a single CLI with first-class AI agent integration.

clawops fills that gap:

| Capability | clawops |
|---|---|
| GCP, AWS, Azure, local VM | ✓ (GCP in v0.2; AWS + Azure in v0.3) |
| Idempotent infra via Pulumi | ✓ |
| SSH transport (no system `ssh`) | ✓ |
| MCP server (embedded + standalone) | ✓ |
| Plan → review → apply discipline | ✓ |
| JSON output everywhere | ✓ |
| No credentials in config | ✓ |

---

## Quick Start

### Prerequisites

- Node.js ≥ 20
- A GCP project with billing enabled + Application Default Credentials (`gcloud auth application-default login`)
- A GCS bucket for Pulumi state (e.g. `gs://my-clawops-state`)

### Install

```bash
npm install -g clawops
# or, without global install:
npx clawops
```

### Provision a GCP instance

```bash
# Write ~/.clawops/config.json and generate an SSH key pair
clawops init --provider gcp

# Edit ~/.clawops/config.json and set stateUrl to your GCS bucket
# stateUrl: "gs://my-clawops-state"

# Preview changes (dry run)
clawops up --dry-run

# Apply — creates VPC, subnet, firewall, static IP, Debian 12 VM, installs Docker + OpenClaw
clawops up
```

### Day-to-day operations

```bash
clawops status              # Show stack outputs (IP, gateway URL, SSH info)
clawops logs -f             # Tail OpenClaw logs via SSH
clawops ssh                 # Interactive SSH session
clawops ssh --command "docker ps"   # Run a remote command

clawops down                # Destroy all infrastructure (requires --yes)
```

---

## Commands

| Command | Description |
|---|---|
| `init` | Interactive setup wizard; writes config, generates SSH key pair |
| `up` | Provision or update stack (`--dry-run` for preview) |
| `down` | Destroy stack (requires `--yes`) |
| `status` | Show stack outputs: IP, gateway URL, region, provisioned time |
| `ssh` | Open interactive SSH session or run a remote command |
| `logs` | Stream OpenClaw logs (`-f` to follow, `--tail N`, `--since 5m`) |
| `tunnel` | Local port-forward to gateway UI over SSH |
| `config` | Get/set remote OpenClaw config values |
| `agents` | List or restart OpenClaw agents |
| `gateway` | Restart the OpenClaw gateway service |
| `backup` | Create or restore an OpenClaw state backup |
| `plan` | Generate a Maker deploy-plan JSON artifact |
| `apply` | Apply a previously reviewed plan file |
| `stacks` | List named stacks and their state |
| `doctor` | Check credentials, SSH connectivity, and dependency health |
| `mcp` | Start the embedded MCP server (`mcp serve`) or install it (`mcp install`) |

Full flag reference: `clawops <command> --help`

---

## Configuration

Config lives at `~/.clawops/config.json` (or `$CLAWOPS_HOME/config.json`).

```json
{
  "version": 1,
  "defaults": {
    "provider": "gcp",
    "region": "us-central1",
    "instanceType": "e2-standard-2"
  },
  "stacks": {
    "default": {
      "provider": "gcp",
      "region": "us-central1",
      "instanceType": "e2-standard-2",
      "stateUrl": "gs://my-clawops-state"
    }
  },
  "ssh": {
    "keyPath": "~/.clawops/id_ed25519",
    "knownHostsPath": "~/.clawops/known_hosts"
  }
}
```

**Cloud credentials are never stored in config.** clawops reads them from the environment:

| Provider | Credential source |
|---|---|
| GCP | `GOOGLE_APPLICATION_CREDENTIALS` or gcloud ADC |
| AWS | `AWS_PROFILE` or standard AWS credential chain |
| Azure | `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` or `az login` |

---

## Architecture

```
clawops
├── src/cli/          citty-based commands (one file per verb)
├── src/config/       ~/.clawops/config.json management
├── src/providers/    Cloud adapters (GCP, AWS, Azure, local)
│   └── gcp/          Pulumi inline program + ProviderAdapter
├── src/pulumi/       Pulumi Automation API wrapper
├── src/transport/    SSH client (ssh2) + connection pool
├── src/mcp/          MCP server + tool definitions
├── src/plan/         Maker plan generation and apply
├── src/output/       ASCII table, JSON, human-readable output
├── src/errors/       Error hierarchy with typed exit codes
└── src/types/        Result<T,E> and shared types
```

Key design decisions:

- **Pulumi Automation API (embedded)**: no `pulumi` binary required; stacks are inline TypeScript closures
- **State in cloud blob storage**: GCS (`gs://`), S3 (`s3://`), Azure Blob — no local state files
- **SSH via `ssh2`**: never shells out to `/usr/bin/ssh`; TOFU host verification; connection pool with 5-min idle TTL
- **Plan → apply discipline**: destructive operations require a reviewable JSON artifact first
- **MCP-first**: every CLI operation is also an MCP tool with typed schemas generated from `spec/mcp-tools.yaml`

See [`docs/architecture.md`](docs/architecture.md) for a full narrative, and [`docs/decisions/`](docs/decisions/) for ADRs.

---

## Development

### Setup

```bash
git clone https://github.com/dfridkin/clawops.git
cd clawops
pnpm install
pnpm dev doctor        # verify toolchain
```

### Scripts

```bash
pnpm dev               # run CLI from src/ (tsx)
pnpm build             # tsup → dist/
pnpm test              # vitest (54 tests, ~1s)
pnpm test:changed      # vitest --changed (edit loop)
pnpm test:pulumi       # Pulumi mock smoke tests
pnpm typecheck         # tsc --noEmit
pnpm lint              # eslint (src/ tests/ scripts/), ~1.4s
pnpm gen:schemas       # regenerate src/providers/types.ts + src/mcp/tools/_generated.ts
pnpm gen:schemas --check   # CI check: generated files match spec
```

### Project layout

| Path | Purpose |
|---|---|
| `spec/` | Machine-readable ground truth: JSON Schema, YAML. **Do not bypass these.** |
| `SPEC.md` | Full technical specification |
| `PRD.md` | Product requirements |
| `DESIGN_RULES.md` | 25 normative rules (R1–R25) referenced throughout the codebase |
| `docs/architecture.md` | Narrative system overview |
| `docs/decisions/` | ADRs for key decisions |
| `.claude/skills/` | Invokable procedures (`/add-provider`, `/release`, `/tdd`, etc.) |
| `.claude/rules/` | Path-scoped lint rules loaded by Claude Code |

### Adding a provider

Use the `/add-provider` skill in Claude Code, or follow [`src/providers/CLAUDE.md`](src/providers/CLAUDE.md). Every adapter must satisfy `ProviderAdapter` in `src/providers/types.ts` (generated from `spec/providers.schema.json`) — do not relax the schema.

### Conventional commits

```
feat(scope): description
fix(scope): description
docs / refactor / chore / test / perf / ci
```

Use `pnpm changeset` to record release notes before merging.

---

## Milestones

| Milestone | Status | What ships |
|---|---|---|
| M0 — Scaffold | ✅ | Tooling, CI, stubs, generated types |
| M1 — GCP MVP | ✅ | `init` / `up` / `down` / `status` / `ssh` / `logs` on GCP |
| M2 — Remote Mgmt | 🔜 | `tunnel`, `config`, `agents`, `gateway`; SSH connection reuse |
| M3 — AWS + Azure | Planned | AWS EC2 + Azure VM adapters; `stacks list` |
| M4 — Local VM | Planned | Local adapter (SSH bootstrap, no Pulumi) |
| M5 — MCP Layer | Planned | `mcp serve` (stdio), all CLI ops as MCP tools |
| M6 — Plan/Apply | Planned | `plan` + `apply`; deploy-plan schema validation |
| M7 — v1.0 Polish | Planned | `doctor` full surface, `--dry-run` everywhere, npm publish |

---

## License

MIT — see [LICENSE](LICENSE).
