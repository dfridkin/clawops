# clawops — Technical Specification

**Version:** 0.2
**Status:** Pre-implementation
**Companion docs:** PRD.md (requirements), DESIGN_RULES.md (R1–R25 normative rules)

This document specifies *how* clawops is built. It assumes you've read the PRD and references the design rules by number throughout (e.g., "per R6, credentials are read from environment").

---

## 1. Repository Structure

```
clawops/
├── CLAUDE.md                          # Root context for Claude Code
├── AGENTS.md                          # Mirror of CLAUDE.md (open standard)
├── README.md                          # Human-facing
├── LICENSE                            # MIT
├── package.json                       # exports + bin
├── tsconfig.json                      # strict mode
├── tsup.config.ts                     # bundler
├── vitest.config.ts                   # test runner
├── .changeset/                        # release workflow
├── .github/
│   └── workflows/
│       ├── ci.yml                     # lint + test + typecheck on PR
│       └── release.yml                # changesets/action publish to npm on merge
├── .claude/
│   ├── settings.json                  # hooks, allowed-tools
│   ├── skills/
│   │   ├── add-provider/SKILL.md
│   │   ├── pulumi-component/SKILL.md
│   │   ├── mcp-tool/SKILL.md
│   │   ├── changeset/SKILL.md
│   │   ├── openclaw-config/SKILL.md
│   │   ├── audit-egress/SKILL.md
│   │   ├── tdd/SKILL.md
│   │   └── release/SKILL.md
│   └── rules/
│       ├── providers.md               # paths: src/providers/**
│       ├── pulumi.md                  # paths: src/pulumi/**
│       ├── mcp.md                     # paths: src/mcp/**
│       └── ssh.md                     # paths: src/transport/**
├── docs/
│   ├── architecture.md
│   ├── providers/<name>.md            # one per provider
│   └── decisions/                     # ADRs
├── spec/
│   ├── providers.schema.json          # ProviderAdapter shape
│   ├── mcp-tools.yaml                 # MCP tool catalog
│   ├── deploy-plan.schema.json        # Maker plan format
│   ├── openclaw-versions.yaml         # version compatibility matrix
│   └── invariants.yaml                # invariants enforced by tests
├── scripts/
│   ├── gen-schemas.ts                 # spec → src/ types
│   ├── scaffold-provider.ts           # used by /add-provider skill
│   └── verify-no-docx.ts              # CI check
├── src/
│   ├── cli/                           # citty entrypoints
│   │   ├── index.ts
│   │   ├── commands/
│   │   │   ├── init.ts
│   │   │   ├── up.ts
│   │   │   ├── down.ts
│   │   │   ├── status.ts
│   │   │   ├── plan.ts
│   │   │   ├── apply.ts
│   │   │   ├── destroy.ts
│   │   │   ├── ssh.ts
│   │   │   ├── tunnel.ts
│   │   │   ├── logs.ts
│   │   │   ├── config.ts
│   │   │   ├── agents.ts
│   │   │   ├── gateway.ts
│   │   │   ├── backup.ts
│   │   │   ├── stacks.ts
│   │   │   ├── doctor.ts
│   │   │   └── mcp.ts                 # mcp serve / mcp install
│   │   └── CLAUDE.md
│   ├── providers/
│   │   ├── index.ts                   # registry
│   │   ├── types.ts                   # ProviderAdapter (GENERATED from spec)
│   │   ├── errors.ts
│   │   ├── aws/
│   │   ├── gcp/
│   │   ├── azure/
│   │   ├── local/
│   │   └── CLAUDE.md
│   ├── pulumi/
│   │   ├── automation.ts              # Pulumi Automation API wrapper
│   │   ├── components/
│   │   │   ├── server.ts
│   │   │   ├── gateway.ts
│   │   │   ├── network.ts
│   │   │   └── secrets.ts
│   │   ├── outputs.ts                 # StackOutputs type + extractors
│   │   └── CLAUDE.md
│   ├── mcp/
│   │   ├── server.ts                  # main MCP server entry
│   │   ├── tools/
│   │   │   ├── _generated.ts          # GENERATED from spec/mcp-tools.yaml
│   │   │   ├── cli/                   # 1:1 CLI command tools
│   │   │   ├── workflow/              # composite tools
│   │   │   └── read/                  # read-only tools
│   │   ├── resources.ts               # MCP resources (current context, regions)
│   │   ├── prompts.ts                 # MCP prompts (workflow templates)
│   │   ├── progress.ts                # progress notification helpers
│   │   ├── audit.ts                   # audit logger (R21)
│   │   └── CLAUDE.md
│   ├── transport/
│   │   ├── ssh.ts                     # ssh2 wrapper
│   │   ├── client.ts                  # exec, stream, tunnel, scp
│   │   └── remote.ts                  # OpenClaw CLI proxy
│   ├── config/
│   │   ├── store.ts                   # ~/.clawops/config.json
│   │   ├── profiles.ts
│   │   └── secrets.ts
│   ├── plan/
│   │   ├── generate.ts                # build Maker plan from intent
│   │   ├── validate.ts                # ajv against deploy-plan.schema.json
│   │   └── apply.ts
│   ├── output/
│   │   ├── human.ts                   # pretty-print + spinners
│   │   ├── json.ts                    # { ok, data, error }
│   │   └── table.ts                   # ASCII table renderer
│   └── index.ts                       # library entry
└── tests/
    ├── providers/                     # mocked SDK tests
    ├── pulumi/
    │   └── components.test.ts         # pulumi.runtime.setMocks() (borrowed pattern)
    ├── mcp/
    │   └── tools.test.ts              # tool invocation + schema validation
    ├── plan/
    │   └── schema.test.ts             # ajv schema conformance
    └── e2e/                           # full-flow tests against LocalStack/sandbox
```

---

## 2. Architectural Layers

### 2.1 Layer Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    CLI Entry (citty)                         │
│  Parses args → routes to command handlers → renders output  │
└──────────────────────────────┬──────────────────────────────┘
                               │
        ┌──────────────────────┼──────────────────────┐
        │                      │                      │
┌───────▼────────┐    ┌────────▼────────┐    ┌────────▼────────┐
│ MCP Server     │    │ Command Handlers│    │ Plan/Apply      │
│ (per R15: stdio│    │ (one per verb)  │    │ (Maker flow)    │
│  embedded;     │    │                 │    │                 │
│  HTTP standalone)│  └────────┬────────┘    └────────┬────────┘
└───────┬────────┘             │                      │
        │                      │                      │
        └──────────────────────┼──────────────────────┘
                               │
                    ┌──────────┴──────────┐
                    │                     │
              ┌─────▼─────┐         ┌─────▼─────┐
              │  Pulumi   │         │   SSH     │
              │ Automation│         │ Transport │
              │    API    │         │  (ssh2)   │
              └─────┬─────┘         └─────┬─────┘
                    │                     │
        ┌───────────┴───────────┐         │
        │                       │         │
┌───────▼─────┐  ┌───────▼──────▼──┐  ┌───▼─────────┐
│  Provider   │  │  Provider       │  │  Provider   │
│  Adapters   │  │  Adapters       │  │  Adapters   │
│  (AWS/GCP/  │  │  (Local VM:     │  │  (any:      │
│   Azure)    │  │   no Pulumi,    │  │   for ssh+  │
│             │  │   bootstrap.sh) │  │   remote ops)│
└──────┬──────┘  └─────────────────┘  └─────────────┘
       │
       ▼
┌──────────────────────────────────────┐
│ State Backend (cloud blob)           │
│   s3://...  gs://...  azblob://...   │
│   file:// for local                  │
└──────────────────────────────────────┘
```

### 2.2 Component Responsibilities

| Layer | Responsibility | Key Modules | Notable Rules |
|---|---|---|---|
| CLI Entry | Argument parsing, help, `--json`, exit codes | `src/cli/` | F26-F29 |
| Command Handlers | Orchestrate a single verb (up, down, etc.) | `src/cli/commands/` | All output via `output/*.ts` only |
| MCP Server | Expose every command as MCP tool + composite workflows | `src/mcp/` | R1–R25 |
| Plan/Apply | Generate, validate, apply Maker plans | `src/plan/` | Borrowed from Clanker pattern |
| Pulumi Engine | Stack lifecycle via Automation API | `src/pulumi/automation.ts` | Embedded engine, no user-installed Pulumi |
| Provider Adapters | Cloud-specific provisioning + connection info | `src/providers/<name>/` | R6 (env credentials), R-meta-1 (schema-validated) |
| SSH Transport | Remote command exec, log streaming, port forward | `src/transport/` | R13 (cancellation) |
| State Backend | Per-stack JSON state in cloud blob | Pulumi-managed | Configured via `clawops init` |

---

## 3. Key Interfaces

### 3.1 ProviderAdapter (generated from `spec/providers.schema.json`)

```typescript
// src/providers/types.ts — GENERATED. Do not hand-edit.
import type { Stack } from "@pulumi/pulumi/automation";

export interface ProviderAdapter {
  /** Lowercase provider id matching the schema enum */
  readonly name: 'aws' | 'gcp' | 'azure' | 'local';

  /** Inline Pulumi program for this provider's stack */
  readonly program: pulumi.automation.PulumiFn;

  /** Extract connection details from a deployed stack's outputs */
  getConnectionInfo(outputs: StackOutputs): ConnectionInfo;

  /** Map an alias like "small" to the provider's native instance type */
  normalizeInstanceType(alias: InstanceAlias): string;

  /** Provider-default region if user didn't specify */
  defaultRegion(): string;

  /** State backend URL prefix for this provider */
  stateBackendUrl(bucket: string): string;

  /** Validate provider-specific config (env vars, profiles) at startup */
  validateConfig(): Promise<ValidationResult>;
}

export interface ConnectionInfo {
  host: string;
  port: number;
  user: string;
  privateKeyPath: string;
  knownHostsPath: string;
}

export type InstanceAlias = 'micro' | 'small' | 'medium' | 'large' | 'gpu';
```

### 3.2 StackOutputs (per provider)

Each adapter returns its own stack outputs object. The shape is provider-specific but conforms to a base interface:

```typescript
export interface BaseStackOutputs {
  instanceId: string;
  publicIp: string;
  gatewayUrl: string;
  sshHost: string;
  sshPort: number;
  sshUser: string;
  region: string;
  provisionedAt: string; // ISO-8601
}
```

### 3.3 DeployPlan (Maker artifact, validated by `spec/deploy-plan.schema.json`)

```typescript
export interface DeployPlan {
  apiVersion: 'clawops.dev/v1';
  kind: 'DeployPlan';
  metadata: {
    name: string;
    generatedAt: string;
    generator: 'clawops' | string; // attribution
  };
  spec: {
    provider: 'aws' | 'gcp' | 'azure' | 'local';
    region?: string;
    stackName: string;
    instanceType: string; // normalized
    openclaw: {
      version: string;
      config: Record<string, unknown>; // openclaw.json overrides
    };
    secrets: SecretRef[]; // never inline values
    network: NetworkSpec;
  };
  diff?: ResourceDiff; // populated by `plan` for review
}
```

### 3.4 MCP Tool definitions

Authored in `spec/mcp-tools.yaml`:

```yaml
version: 1
toolsets:
  - id: cli
    description: 1:1 mappings of clawops CLI commands
  - id: workflow
    description: Composite agent workflows (R2)
  - id: read
    description: Read-only tools, enabled in --read-only mode
  - id: admin
    description: Stack management, multi-stack ops

tools:
  - name: clawops_status
    toolset: read
    description: |
      Get current status of a clawops-managed stack.
      
      Use when: the user asks about the health of a deployed instance,
      whether the gateway is responding, or wants a quick overview.
      
      Do NOT use when: the user asks for live logs (use clawops_logs)
      or wants to see specific configuration values (use clawops_config_get).
    annotations:
      title: Get Stack Status
      readOnlyHint: true
      destructiveHint: false
      idempotentHint: true
      openWorldHint: true
    input:
      stackName:
        type: string
        optional: true
        description: Stack name; defaults to active stack from env
    output:
      health: { type: enum, values: [healthy, degraded, down, unknown] }
      gatewayUrl: { type: string, format: uri }
      uptime: { type: string }
      openclawVersion: { type: string }
      agentCount: { type: integer }
```

The TypeScript Zod schemas in `src/mcp/tools/_generated.ts` are emitted by `scripts/gen-schemas.ts`.

---

## 4. Pulumi Automation API Strategy

Per R15 and the embedded-engine decision in PRD §9 (Q3):

```typescript
// src/pulumi/automation.ts (illustrative)
import { LocalWorkspace } from '@pulumi/pulumi/automation';

export async function getOrCreateStack(opts: StackOpts) {
  return await LocalWorkspace.createOrSelectStack(
    {
      stackName: opts.stack,
      projectName: 'clawops',
      program: opts.adapter.program(opts), // inline closure
    },
    {
      workDir: undefined, // no on-disk project
      pulumiHome: path.join(opts.configDir, '.pulumi'),
      envVars: {
        PULUMI_BACKEND_URL: opts.stateUrl,
        // R6: credentials inherited from process env, never set here
      },
    }
  );
}
```

Key properties:
- **No `pulumi.yaml` written to disk.** Project is ephemeral, in-memory.
- **State backend URL** comes from `~/.clawops/config.json` (set during `clawops init`).
- **`pulumiHome`** sandboxed under `~/.clawops/.pulumi` to avoid clobbering user's other Pulumi projects.
- **Inline programs** are closures from each ProviderAdapter — no shelling out to `pulumi up` external binary.

### 4.1 Pulumi Component Convention (borrowed from schmitthub/openclaw-deploy)

Per R-meta-1 and the deep dive findings, all Pulumi components in `src/pulumi/components/` follow this pattern:

```typescript
// src/pulumi/components/gateway.ts
import * as pulumi from '@pulumi/pulumi';

export interface GatewayArgs {
  serverIp: pulumi.Input<string>;
  connection: pulumi.Input<command.types.input.remote.ConnectionArgs>;
  openclawVersion: pulumi.Input<string>;
  configHash: pulumi.Input<string>;
  // every input is pulumi.Input<T>
}

export class Gateway extends pulumi.ComponentResource {
  public readonly containerId: pulumi.Output<string>;
  public readonly gatewayUrl: pulumi.Output<string>;

  constructor(name: string, args: GatewayArgs, opts?: pulumi.ComponentResourceOptions) {
    super('clawops:app:Gateway', name, {}, opts); // URN convention

    // children created with { parent: this }
    const container = new docker.Container(`${name}-container`, {
      // ...
    }, { parent: this });

    this.containerId = container.id;
    this.gatewayUrl = pulumi.interpolate`https://${args.serverIp}:18789`;

    this.registerOutputs({ containerId: this.containerId, gatewayUrl: this.gatewayUrl });
  }
}
```

URN namespace categories: `clawops:infra:*` (Server, HostBootstrap), `clawops:net:*` (Firewall, Tunnel), `clawops:app:*` (Gateway, GatewayInit), `clawops:build:*` (Image), `clawops:state:*` (Secrets, ConfigStore).

### 4.2 Pulumi Mock Test Pattern (also borrowed from schmitthub)

```typescript
// tests/pulumi/components.test.ts
import * as pulumi from '@pulumi/pulumi';

pulumi.runtime.setMocks({
  newResource: (args) => {
    // tag mock outputs by args.type (e.g., aws:ec2/instance:Instance)
    const baseOutputs: Record<string, unknown> = {
      'aws:ec2/instance:Instance': { publicIp: '203.0.113.1', id: 'i-mock' },
      'gcp-native:compute/v1:Instance': { networkInterfaces: [{ accessConfigs: [{ natIP: '203.0.113.2' }]}] },
      'docker:index/container:Container': { id: 'container-mock' },
    };
    return {
      id: `${args.name}-id`,
      state: { ...args.inputs, ...baseOutputs[args.type] },
    };
  },
  call: (args) => args.inputs,
});

// tests assert that components wire up outputs correctly without any cloud calls
```

---

## 5. CLI Command Surface

All commands follow `clawops <noun> [subcommand] [flags]`. Global flags per F26–F29.

### 5.1 Global Flags

| Flag | Type | Description |
|---|---|---|
| `--stack <name>` | string | Target named stack (default from config) |
| `--provider <p>` | enum | Override provider |
| `--json` | bool | Emit JSON to stdout |
| `--quiet` | bool | Suppress non-error output |
| `--profile <n>` | string | Auth profile from `~/.clawops/config.json` |
| `--dry-run` | bool | Preview without applying (mutating commands) |
| `--yes` | bool | Skip interactive confirmations (CI mode) |

### 5.2 Verbs (full reference)

See `spec/mcp-tools.yaml` for canonical inputs/outputs. The CLI surface mirrors the MCP tool surface 1:1 (R1: `clawops_cli_*` toolset).

Commands and their primary flag groups:

```bash
# Lifecycle
clawops init [--provider <p>] [--state <url>] [--non-interactive]
clawops up [--provider <p>] [--region <r>] [--instance-type <t>] [--dry-run] [--no-wait] [--openclaw-version <v>]
clawops down [--destroy]
clawops destroy [--yes]
clawops plan [--provider <p>] [--out plan.json]
clawops apply <plan.json> [--yes]
clawops refresh                       # detect drift
clawops status [--json]

# Remote ops
clawops ssh [-- <command>]
clawops tunnel [--port 18789] [--no-open]
clawops logs [-f] [--tail N] [--since DURATION]
clawops config get <key>
clawops config set <key> <value> [--restart]
clawops config unset <key>
clawops agents list [--json]
clawops agents restart <agentId>
clawops agents logs <agentId> [-f]
clawops gateway status
clawops gateway restart
clawops gateway update [--channel stable|dev|<version>]
clawops backup create [--out path]
clawops backup restore <path>

# Stack management
clawops stacks list [--json]
clawops stacks delete <name> [--yes]

# Diagnostics
clawops doctor
clawops version

# MCP
clawops mcp serve [--http <port>] [--bind <addr>] [--read-only] [--no-destructive] [--toolsets <list>] [--inspector]
clawops mcp install --claude | --cursor | --vscode | --windsurf | --zed
```

---

## 6. Provider Adapters

### 6.1 AWS Adapter (`src/providers/aws/`)

**Resources:** EC2 instance (Ubuntu 22.04 AMI), Security Group (deny by default; SSH 22 + gateway 18789 require explicit CIDR), Elastic IP, IAM instance profile (least-privilege), SSM Parameter Store entry for gateway token.

**Auth (R6):** `AWS_PROFILE` or IAM role via instance metadata. Supports AWS SSO. `AWS_REGION` overrideable.

**State backend:** `s3://bucket/clawops`

**Bedrock integration:** When `--openclaw-config-bedrock` is set, registers Bedrock as a model provider in the rendered `openclaw.json`. **Important:** OpenClaw 2026.4.5+ requires `AWS_PROFILE` set in the systemd `EnvironmentFile=` (not `auth: "aws-sdk"` in openclaw.json). Adapter emits both for compatibility — see `spec/openclaw-versions.yaml`.

**OIDC pattern for CI:** clawops's own release/CI workflow uses the OIDC pattern documented in Yash-Kavaiya/openclaw-bedrock-ec2's `github-oidc.tf` (re-implemented from GitHub docs, not vendored — license blocker).

### 6.2 GCP Adapter (`src/providers/gcp/`)

**Resources:** Compute Engine VM (Debian 12), Firewall rules, Static external IP, Service Account with least-privilege IAM, Secret Manager for gateway token.

**Auth:** ADC via `gcloud auth application-default login` or `GOOGLE_APPLICATION_CREDENTIALS`.

**State backend:** `gs://bucket/clawops`

### 6.3 Azure Adapter (`src/providers/azure/`)

**Resources:** Resource Group, VM (Ubuntu 22.04), NSG (SSH + gateway port), Public IP, Managed Identity, Key Vault secret. SSH-only auth.

**Auth:** `az login` or Service Principal (`AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`).

**State backend:** `azblob://container/clawops`

### 6.4 Local VM Adapter (`src/providers/local/`)

**Targets:** Any Linux VM reachable over SSH (UTM, VirtualBox, bare metal, Proxmox).

**Provisioning:** No Pulumi. Adapter SSHes in and runs an idempotent bootstrap script (install Node.js 22, Docker, OpenClaw, configure systemd unit). Bootstrap script is in `src/providers/local/bootstrap.sh.tmpl` — borrows the systemd unit hygiene pattern from Yash-Kavaiya/openclaw-bedrock-ec2.

**State:** `file://~/.clawops/state/<stack>.json`

**Config:** User provides connection info via `clawops init --provider local --host 192.168.1.50 --user ubuntu --key-path ~/.ssh/id_ed25519`.

---

## 7. MCP Server

Per R1–R25.

### 7.1 Server Modes

- **Embedded (`clawops mcp serve`):** stdio default (R15), single-user, stateful (R16). Used by Claude Desktop, Cursor, VS Code via local config.
- **Standalone (`@clawops/mcp-server`):** Streamable HTTP, stateless toggle (R16), OAuth 2.1 resource server in production (R20). Distributed as a separate npm package with Docker image.

### 7.2 Tool Categories

**Toolsets (R1):**
- `cli` — 1:1 wrappers for every CLI command (`clawops_cli_up`, `clawops_cli_status`, etc.)
- `workflow` — 2–3 carefully chosen composites (R2):
  - `clawops_workflow_deploy_app` (preview → confirm → up → verify)
  - `clawops_workflow_recover` (status → logs → diagnostic)
  - `clawops_workflow_migrate_provider` (export → provision new → restore → cutover)
- `read` — explicitly read-only subset enabled in `--read-only` mode (R18)
- `admin` — multi-stack ops, requires elevated profile

### 7.3 Resources (R4)

- `clawops://current-context` — active stack name, provider, region
- `clawops://stacks` — enumeration of known stacks
- `clawops://stacks/{name}/last-run` — full Pulumi output from last `up`/`destroy`
- `clawops://providers/{name}/regions` — available regions per provider
- `clawops://openclaw-versions` — supported OpenClaw versions

### 7.4 Prompts (R4)

- `deploy-to-aws` — guided AWS deployment workflow
- `recover-failed-stack` — diagnostic/remediation playbook
- `migrate-to-clawops` — onboarding workflow for users coming from manual deployments

### 7.5 Long-Running Operations (R12, R13)

`clawops_cli_up`, `clawops_workflow_deploy_app`, etc.:
1. If estimated duration <10s: synchronous return.
2. If 10–60s: emit `notifications/progress` every 2 seconds.
3. If >60s: return `taskId` immediately; expose `clawops_task_status` for polling. Cancellation via `notifications/cancelled` propagates to Pulumi engine via `ctx.signal.addEventListener('abort', () => stack.cancel())`.

### 7.6 Output Trimming (R14)

Pulumi raw output is trimmed before tool return. Full output exposed at `clawops://stacks/{name}/last-run`. Tool result hard cap: 8KB.

### 7.7 Audit Logging (R21)

`src/mcp/audit.ts` writes structured JSON to stderr:

```json
{
  "ts": "2026-05-01T12:34:56.789Z",
  "sessionId": "01HXY...ULID",
  "tool": "clawops_cli_up",
  "args": { "stackName": "prod", "provider": "aws", "region": "us-east-1" },
  "durationMs": 142000,
  "result": "ok",
  "resourceCount": 7
}
```

Sanitization (sensitive keys stripped): `Authorization`, `*token*`, `*secret*`, `*key*` (except `keyName` / `keyPath`), `password`, `connectionString`. Full ARNs replaced with `arn:aws:***:<region>:<account>:***`.

---

## 8. State Management

### 8.1 Per-Provider State URLs

| Provider | State URL | Auth |
|---|---|---|
| AWS | `s3://my-bucket/clawops` | `AWS_PROFILE` or IAM role |
| GCP | `gs://my-bucket/clawops` | ADC |
| Azure | `azblob://container/clawops` | `AZURE_CLIENT_ID + AZURE_TENANT_ID` |
| Local | `file://~/.clawops/state` | Filesystem |

### 8.2 First-Run Setup

`clawops init` walks through:
1. Pick provider
2. Pick state backend URL (auto-suggests based on detected credentials)
3. Pick default stack name
4. Generate or import SSH keypair (auto-generates per Q2; `--key-path` for import)
5. Write `~/.clawops/config.json`
6. Run `clawops doctor` to verify

### 8.3 Config File Format

`~/.clawops/config.json` (per R6, no secrets here):

```json
{
  "version": 1,
  "defaults": {
    "stack": "default",
    "provider": "gcp"
  },
  "stacks": {
    "default": {
      "provider": "gcp",
      "stateUrl": "gs://my-bucket/clawops",
      "region": "us-central1",
      "credentialsRef": {
        "source": "env",
        "envVars": ["GOOGLE_APPLICATION_CREDENTIALS"]
      }
    },
    "prod-aws": {
      "provider": "aws",
      "stateUrl": "s3://my-prod-bucket/clawops",
      "region": "us-east-1",
      "credentialsRef": {
        "source": "cli-profile",
        "profileName": "production"
      }
    }
  },
  "ssh": {
    "keyPath": "~/.clawops/keys/id_ed25519",
    "knownHostsPath": "~/.clawops/known_hosts"
  },
  "mcp": {
    "auditLogPath": "~/.clawops/mcp-audit.log"
  }
}
```

---

## 9. Dependencies

| Package | Version | Purpose | Rule |
|---|---|---|---|
| `@pulumi/pulumi` | ^3.x | Automation API engine | — |
| `@pulumi/aws` | ^6.x | AWS provider | — |
| `@pulumi/gcp` | ^7.x | GCP provider | — |
| `@pulumi/azure-native` | ^2.x | Azure provider | — |
| `@pulumi/command` | ^1.x | Remote command resource | — |
| `@pulumi/docker` | ^4.x | Docker container resource | — |
| `@modelcontextprotocol/sdk` | ~1.29.0 | MCP server primitives | R25 |
| `citty` | ^0.1.x | CLI framework | Q1 |
| `ssh2` | ^1.x | SSH transport | — |
| `ora` | ^8.x | Spinners (suppressed in --json) | F27 |
| `chalk` | ^5.x | Terminal color | — |
| `conf` | ^12.x | Config file management | — |
| `inquirer` | ^9.x | Interactive prompts (init wizard) | — |
| `zod` | ^3.x | Runtime schema validation | R8 |
| `ajv` | ^8.x | JSON Schema validation | R-meta-4 |
| `vitest` | ^1.x | Test runner | — |
| `tsup` | ^8.x | Bundler | — |
| `aws-sdk-client-mock` | ^4.x | AWS SDK testing | TDD |
| `nock` | ^14.x | HTTP mocking | TDD |
| `@changesets/cli` | ^2.x | Release management | — |

---

## 10. CI/CD

### 10.1 PR Workflow (`.github/workflows/ci.yml`)

```yaml
jobs:
  ci:
    steps:
      - checkout
      - setup-node@v4 (Node 20.x and 22.x matrix)
      - pnpm install --frozen-lockfile
      - pnpm gen:schemas --check     # R-meta-1
      - scripts/verify-no-docx.ts    # R-meta-2
      - pnpm typecheck
      - pnpm lint --max-warnings=0
      - pnpm test --coverage
      - upload coverage to Codecov
```

### 10.2 Release Workflow (`.github/workflows/release.yml`)

Uses `changesets/action@v1`:
- On merge to `main`: opens or updates a "Version Packages" PR
- On merge of Version Packages PR: runs `pnpm release` (which calls `tsup build && npm publish --provenance`)
- Provenance via `id-token: write` + `--provenance` flag

### 10.3 No `git push` from CI

Per Anthropic security guidance: release workflow has minimum permissions, GH token scoped to `contents: write, packages: write, id-token: write` only.

---

## 11. Test Strategy

Per the TDD rule and the Claude Code research findings:

### 11.1 Unit Tests

- **Provider adapters:** Mock all SDK calls via `@aws-sdk/client-mock`, `nock` for REST.
- **Pulumi components:** `pulumi.runtime.setMocks()` with type-tagged outputs.
- **MCP tools:** Invoke against an in-memory MCP client; assert schema conformance.
- **Plan generation:** `ajv` validates against `spec/deploy-plan.schema.json`.

### 11.2 Integration Tests

- **SSH transport:** Test against `linuxserver/openssh-server` in a Docker container.
- **Local provider:** Full provision/destroy cycle in CI against a Vagrant or Multipass VM.

### 11.3 E2E Tests

- **Sandbox account testing:** Optional separate workflow (`.github/workflows/e2e-aws.yml`, manually triggered) that runs against a dedicated AWS sandbox account with budget alerts.
- **LocalStack:** Daily scheduled job runs `clawops up --provider aws` against LocalStack to catch regressions cheaply.

### 11.4 Coverage Targets

- v1.0: 70% line coverage overall, 90% on `src/providers/types.ts` adherence (interface compliance), 100% on `src/plan/validate.ts`.

---

## 12. Phased Implementation Roadmap

(Mirrors PRD §7. Detail of acceptance criteria per milestone.)

### M0 — Skeleton (Week 1) ✅
- [x] Repo scaffold with all directories from §1
- [x] `pnpm install`, `pnpm typecheck`, `pnpm test` all green on empty test
- [x] CI pipeline running on PR
- [x] `clawops --version` works
- [x] `clawops doctor` checks: node version, presence of credentials env vars
- [x] CLAUDE.md, AGENTS.md, all `.claude/skills/` and `.claude/rules/` present
- [x] First ADR (0001-supersede-word-doc.md) committed

### M1 — GCP MVP (Week 3) ✅
- [x] `src/pulumi/automation.ts` working against `gs://` backend
- [x] GCP adapter: provision VM + firewall + static IP
- [x] `clawops init --provider gcp --non-interactive` writes valid config
- [x] `clawops up` end-to-end against real GCP project (sandbox)
- [x] `clawops down --destroy` cleanly removes all resources
- [x] `clawops status --json` returns valid output
- [x] `clawops ssh` opens session
- [x] `clawops logs -f` streams gateway logs

### M2 — Remote Mgmt (Week 5) ✅
- [x] `clawops tunnel` forwards port + opens browser
- [x] `clawops config get/set/unset` against remote OpenClaw
- [x] `clawops agents list/restart` proxies cleanly
- [x] `clawops gateway status/restart/update` works
- [x] SSH transport supports cancellation (R13)

### M3 — AWS + Azure (Week 8)
- [ ] AWS adapter: full lifecycle, Bedrock optional
- [ ] Azure adapter: full lifecycle, Key Vault integration
- [ ] `clawops stacks list/delete` for multi-stack
- [ ] `--stack` flag fully wired across all commands
- [ ] OIDC GitHub Actions workflow as docs/example

### M4 — Local VM (Week 10)
- [ ] Local adapter: SSH bootstrap, no Pulumi
- [ ] `file://` state backend
- [ ] `clawops backup create/restore`

### M5 — MCP Layer (Week 12)
- [ ] `clawops mcp serve` (stdio) with all CLI tools registered
- [ ] All tools annotated per R10
- [ ] `--read-only` and `--no-destructive` modes filtering at registration
- [ ] Elicitation wired for destructive tools
- [ ] `clawops mcp install --claude/--cursor/...` writes correct config
- [ ] Composite `clawops_workflow_deploy_app` working
- [ ] Audit log writing structured JSON

### M6 — Plan/Apply (Week 14)
- [ ] `spec/deploy-plan.schema.json` finalized
- [ ] `clawops plan --out plan.json` emits valid plan
- [ ] `clawops apply plan.json` executes deterministically
- [ ] Plan diff rendering for human review
- [ ] MCP `clawops_workflow_deploy_app` uses plan flow internally

### M7 — v1.0 Polish (Week 16)
- [ ] `clawops doctor` covers all credentials, state backends, SSH keys, Pulumi engine
- [ ] All mutating commands support `--dry-run`
- [ ] CI integration guide (docs/ci.md)
- [ ] Restore `.github/workflows/release.yml` (removed in M3 to save Actions minutes): changesets/action creates version-bump PRs; on merge runs `pnpm release` → `tsup build && npm publish --provenance`
- [ ] First npm publish with `--provenance`
- [ ] README + docs site (clawops.dev) live
- [ ] Demo video / blog post

---

## 13. References to Borrowed Patterns

Per the deep dive in research deliverable 4:

| From | What we borrow | Where it appears |
|---|---|---|
| schmitthub/openclaw-deploy | Pulumi component URN convention | §4.1 |
| schmitthub/openclaw-deploy | Pulumi mock test harness | §4.2 |
| schmitthub/openclaw-deploy | Two-tier shared/per-gateway composition | docs/architecture.md |
| schmitthub/openclaw-deploy | Five-layer egress reference architecture | docs/architecture.md (security section) |
| Yash-Kavaiya/openclaw-bedrock-ec2 | OIDC GH Actions pattern (re-implemented from GH docs) | §10.2 |
| Yash-Kavaiya/openclaw-bedrock-ec2 | Bedrock provider JSON shape (as fixture) | tests/providers/aws/bedrock-config.fixture.json |
| Yash-Kavaiya/openclaw-bedrock-ec2 | systemd unit hygiene | src/providers/local/bootstrap.sh.tmpl |
| Clanker | Plan-then-apply (Maker) pattern | §3.3 (DeployPlan), F5–F6 |
| Clanker | Local-CLI-profile credentials stance | R6, §8.3 |
| Clanker | MCP server-as-CLI-mode dual transport | F18–F19, §7 |
| Clanker | Retry-and-escalate-to-AI pattern | §11 (test strategy mentions error taxonomy) |
| Pulumi MCP server | `pulumi-cli-*` prefix and per-call args pattern | R5, §7.2 |
| Fly.io flyctl | `--claude` / `--cursor` one-flag install | R23, F20 |
| HashiCorp Terraform MCP | Stateful/stateless toggle | R16, §7.1 |
| Kubernetes MCP servers | `--read-only` / `--no-destructive` filter at registration | R18, F23 |

---

## 14. Anti-Goals (deliberately not doing)

- **No web UI in v1.** Even a tiny one creates a maintenance burden disproportionate to value vs. the agent integration path.
- **No multi-region failover** in v1. Single-region per stack; multi-stack for HA.
- **No custom OpenClaw fork or build pipeline.** clawops uses upstream OpenClaw releases only.
- **No native Windows.** WSL2 is the supported path. Saves ~3 weeks of test matrix.
- **No `clawops` as a daemon.** It's a CLI + MCP server. No persistent process beyond the user's shell session and the MCP server (which lives only as long as the client keeps it open).
- **No automatic secret rotation in v1.** Out of scope; document the manual rotation procedure.
- **No spec changes without ADR.** R-meta-3 is binding.
