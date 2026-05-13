# clawops — Technical Specification

**Version:** 0.9
**Status:** M8 complete (493 unit+e2e tests); Waves 3–8B complete — WO-01–WO-17, WO-19–WO-22 done; WO-18, WO-23, WO-24, WO-26, WO-27, WO-28 pending
**Companion docs:** PRD.md (requirements), DESIGN_RULES.md (R1–R25 normative rules)

This document specifies *how* clawops is built. It assumes you've read the PRD and references the design rules by number throughout (e.g., "per R6, credentials are read from environment").

---

## 1. Repository Structure

```
clawops/
├── CLAUDE.md                          # Root context for Claude Code
├── AGENTS.md                          # Mirror of CLAUDE.md (open standard)
├── README.md                          # Human-facing
├── LICENSE                            # MPL-2.0
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
│   ├── ci.md                          # CI integration guide (OIDC, env vars, plan/apply in CI)
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
    │   ├── tools.test.ts              # tool invocation + schema validation
    │   ├── server.test.ts             # MCP server bootstrap + stdio transport
    │   ├── http.test.ts               # StreamableHTTP transport
    │   ├── apply.test.ts              # handleApply() handler
    │   ├── plan.test.ts               # handlePlan() handler
    │   └── deploy_app.test.ts         # handleWorkflowDeployApp() handler
    ├── plan/
    │   ├── schema.test.ts             # ajv schema conformance
    │   ├── validate.test.ts           # validatePlan / assertValidPlan
    │   ├── generate.test.ts           # generatePlan() + diff parsing
    │   └── apply.test.ts              # applyPlan() execution
    ├── cli/
    │   ├── commands.test.ts           # command registration smoke tests
    │   ├── doctor.test.ts             # doctor surface checks
    │   ├── destroy.test.ts            # destroy flow (local guard, --dry-run, --yes)
    │   ├── down.test.ts               # down flow (--dry-run, --yes)
    │   ├── apply.test.ts              # apply flow (--dry-run, readline confirm)
    │   └── plan.test.ts               # plan flow (--out, provider forwarding)
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
clawops down [--yes] [--dry-run]                   # local provider; --dry-run shows current outputs
clawops destroy [--yes] [--dry-run]                # cloud providers; --dry-run shows current outputs
clawops plan [--provider <p>] [--out plan.json]
clawops apply <plan.json> [--yes] [--dry-run]      # --dry-run validates + shows diff, no apply
clawops refresh                       # detect drift
clawops status [--json]

# Remote ops
clawops ssh [-- <command>]
clawops tunnel [--port 18789] [--no-open]
clawops logs [-f] [--tail N] [--since DURATION]
clawops config get <key>
clawops config set <key> <value> [--restart] [--dry-run]
clawops config unset <key> [--dry-run]
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

- **stdio mode (`clawops mcp serve`):** default (R15), single-user, stateful (R16). Used by Claude Desktop, Cursor, VS Code via local config.
- **HTTP mode (`clawops mcp serve --http`):** Streamable HTTP, stateless toggle (`--stateless`, R16), OAuth 2.1 resource server in production (R20). Both modes ship in `@clawops/cli`.

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
| `@modelcontextprotocol/sdk` | ^1.0.0 | MCP server primitives (stdio + StreamableHTTP) | R25 |
| `citty` | ^0.1.x | CLI framework | Q1 |
| `ssh2` | ^1.x | SSH transport | — |
| `ora` | ^8.x | Spinners (suppressed in --json) | F27 |
| `chalk` | ^5.x | Terminal color | — |
| `conf` | ^12.x | Config file management | — |
| `inquirer` | ^9.x | Interactive prompts (init wizard) | — |
| `zod` | ^3.x | Runtime schema validation | R8 |
| `ajv` | ^8.x | JSON Schema validation | R-meta-4 |
| `ajv-formats` | ^3.x | date-time / uri formats for ajv | R-meta-4 |
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
      - setup-node@v6 (Node 22.x)
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
- Publish step guarded by `HAS_NPM_TOKEN` env check — no-ops safely when `NPM_TOKEN` secret is absent

### 10.3 CI Deployments (`docs/ci.md`)

See [`docs/ci.md`](docs/ci.md) for the full guide covering:
- Writing `~/.clawops/config.json` from env vars (never `clawops init` in CI)
- AWS OIDC via `aws-actions/configure-aws-credentials@v4`
- GCP Workload Identity Federation via `google-github-actions/auth@v2`
- Provider-specific env var reference table
- Plan → artifact → apply pattern across jobs
- `clawops doctor` and `--dry-run` as preflight checks

### 10.4 No `git push` from CI

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

### M3 — AWS + Azure (Week 8) ✅
- [x] AWS adapter: full lifecycle, Bedrock optional
- [x] Azure adapter: full lifecycle, Key Vault integration
- [x] `clawops stacks list/delete` for multi-stack
- [x] `--stack` flag fully wired across all commands
- [x] OIDC GitHub Actions workflow as docs/example

### M4 — Local VM (Week 10) ✅
- [x] Local adapter: SSH bootstrap, no Pulumi
- [x] `file://` state backend (`~/.clawops/state/<stack>.json`, atomic write)
- [x] `clawops backup create/restore` (docker exec streaming)
- [x] `clawops init --provider local --host <HOST>` writes `localOpts`
- [x] `clawops up` local path: renders bootstrap.sh.tmpl, runs over SSH, polls health
- [x] `clawops status` local path: reads `LocalState`, renders table or "not bootstrapped"
- [x] `clawops ssh` local path: connects using `LocalState` connection info
- [x] Pre-M5 coverage pass: 239 tests across 27 files (errors, outputs, validate, pool, context, init, status, up); 336 tests across 40 files at M6

### M5 — MCP Layer (Week 12) ✅
- [x] `clawops mcp serve` (stdio) with all CLI tools registered
- [x] All tools annotated per R10
- [x] `--read-only` and `--no-destructive` modes filtering at registration
- [x] Elicitation wired for destructive tools
- [x] `clawops mcp install --claude/--cursor/...` writes correct config
- [x] Composite `clawops_workflow_deploy_app` working
- [x] Audit log writing structured JSON (stderr + disk)
- [x] **HTTP transport:** `--http` flag initially threw UsageError (M5); implemented in M6 via `StreamableHTTPServerTransport`.

### M6 — Plan/Apply (Week 14) ✅
- [x] `spec/deploy-plan.schema.json` finalized
- [x] `clawops plan [--out plan.json]` emits valid plan; diff table rendered to stderr
- [x] `clawops apply <plan.json>` executes deterministically with readline confirmation
- [x] Plan diff rendering for human review (create/update/delete counts + resource table)
- [x] MCP `clawops_workflow_deploy_app` uses plan flow internally (generatePlan → diff-informed elicitation → applyPlan)
- [x] `clawops mcp serve --http <port>` implemented via `StreamableHTTPServerTransport`
- [x] 336 tests passing across 40 test files

### M7 — v1.0 Polish (Week 16) ✅
- [x] `clawops doctor` covers Node version, config validity, SSH key, provider credentials, Pulumi home dir
- [x] All mutating commands support `--dry-run` (`up` already had it; added to `down`, `destroy`, `apply`, `config`)
- [x] CI integration guide (`docs/ci.md`): OIDC for AWS/GCP, env vars reference, plan/apply in CI, no `clawops init` in CI
- [x] Restore `.github/workflows/release.yml`: changesets/action creates version-bump PRs; on merge runs `pnpm release` → `tsup build && npm publish --provenance`
- [x] `clawops destroy` implemented (was a stub throwing `Error('not yet implemented (M1)')`)
- [x] 356 tests passing across 40 test files
- [ ] First npm publish with `--provenance`
- [ ] README + docs site (clawops.dev) live
- [ ] Demo video / blog post

### M8 — Test Coverage & SSH Hardening (Week 20)
- [x] GCP Pulumi program unit test (parity with AWS + Azure)
- [x] Firewall module unit tests (`resolveIngressCidrs`, `detectEgressIp`, all access modes)
- [x] CLI unit tests: `logs`, `ssh`, `backup`, `mcp serve`
- [x] MCP tool handler unit tests: `agents`, `status`, `stacks`, `up`, `destroy`, `gateway`, `config`, `logs`, `task`, `recover`
- [x] Up command cloud provider path unit tests (AWS mock)
- [x] Plan → apply → status mock e2e (`tests/e2e/deploy.test.ts`)
- [x] AbortSignal forwarded from `applyPlan` to `stack.up()` (bug fix)
- [x] SSH integration test harness (`testcontainers` + `linuxserver/openssh-server`)
- [x] SSH error path integration tests: ECONNREFUSED, auth failure, TOFU, host-key mismatch, mid-exec abort, tunnel EADDRINUSE
- [x] Local bootstrap integration tests: happy path, non-zero exit, health poll timeout, abort
- [x] Output module unit tests (`human.ts`, `table.ts`)
- [ ] `src/config/profiles.ts` + `secrets.ts` — implement stubs fully + tests
- [ ] `src/pulumi/components/` — implement `Gateway`, `Network`, `Secrets`, `Server` ComponentResources + tests
- [x] 493 tests passing (unit + e2e); integration suite separate (`pnpm test:integration`, Docker required)

---

## 14. References to Borrowed Patterns

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

## 15. Adoption & Traction Roadmap

This section tracks the eight adoption milestones defined in `docs/roadmap-docs/`. These are
**distinct from the M0–M8 development milestones in §12**. Development milestones track *what is
built*; adoption milestones track *whether the repo is understandable, trustworthy, and launchable*.

Milestone labels use `R1–R11` to avoid collision. Each milestone maps to one or more work orders
(WO-01 through WO-28) in `docs/roadmap-docs/docs/implementation/work-orders.md`.

Execution is organized into waves (see `docs/roadmap-docs/docs/implementation/milestones.md`).
WO-04 must be completed before WO-01 to avoid perpetuating inaccurate plan/apply language in the README.

### Wave structure

| Wave | Work Orders | Milestone(s) | Gate |
|---|---|---|---|
| 1 | WO-04, WO-01, WO-22, WO-17 | R1, R2, R6, R8 | Minimum viable public launch gate |
| 2 | WO-02, WO-03 | R1 | First-run experience complete |
| 3 | WO-07, WO-08, WO-09 | R3 | Soft launch: MCP safety documented |
| 4 | WO-05, WO-06 | R2 | Plan surface code (WO-06 design-first) |
| 5 | WO-10, WO-11, WO-13 | R4 | Operations guides |
| 6 | WO-12, WO-14, WO-15 | R4, R5 | Operational code |
| 7 | WO-19, WO-20, WO-21 | R6, R7 | Contributor + provider docs |
| 8 | WO-23, WO-24 | R8 | Launch execution |
| 9 | WO-25 | R9 | Secret lifecycle management |
| 10 | WO-26, WO-27 | R10 | Stack monitoring wizard |
| 11 | WO-28 | R11 | Gateway-agent MCP wiring |

### R1 — First-Run Experience

Goal: let someone understand, install, deploy, and validate ClawOps quickly.

Work orders: WO-01 (README), WO-02 (local/VPS quickstart), WO-03 (example configs).

Deliverables:
- `docs/quickstart.md`
- `docs/examples/local-vm.md`
- `docs/examples/aws-basic.md`
- `examples/configs/` with realistic model/channel examples
- README rewrite (positioning, quickstart inline, what it does/does not do)

Status:
- [x] WO-01: README positioning and first-success path
- [x] WO-02: Local/VPS quickstart
- [x] WO-03: Example OpenClaw model/channel configs

### R2 — Plan/Apply Trust Model

Goal: make plan/apply behavior accurate, inspectable, and safe.

Work orders: WO-04 (semantics docs), WO-05 (plan summary output), WO-06 (drift warning design).

**Important:** `clawops apply` re-runs `pulumi up` against the current live state using the
parameters from the reviewed plan JSON. It does **not** execute a locked, provider-level plan
artifact. This is intentional (no Pulumi native plan artifact API exists for programmatic use), but
must be clearly documented. WO-04 must land before WO-01 to keep README language accurate.

WO-06 (apply-time drift warning) touches `spec/deploy-plan.schema.json`, generated types, and
`src/plan/apply.ts`. Treat as design-first: ADR required before implementation.

Deliverables:
- `docs/plan-apply.md` — precise semantics, what "plan" guarantees vs. does not guarantee
- Plan summary table in `clawops plan` output
- Drift warning on `clawops apply` when state changed since plan generation

Status:
- [x] WO-04: Plan/apply semantics docs
- [x] WO-05: Plan summary output
- [x] WO-06: Apply-time drift warning (design-first — ADR before code)

### R3 — Security and MCP Safety

Goal: give users a clear safety model for ClawOps as privileged tooling and MCP server.

Work orders: WO-07 (MCP safety docs + tool risk matrix), WO-08 (read-only/no-destructive setup
docs), WO-09 (audit log examples + redaction guarantees).

Tool risk categories (from `docs/roadmap-docs/docs/security/mcp-safety-plan.md`):

| Risk Level | Examples | Required guardrail |
|---|---|---|
| Read-only | `status`, `logs`, `config get` | Redaction, output cap |
| Diagnostic | `doctor`, `task status` | Redaction, timeout |
| Operational | `gateway restart`, `agents restart` | Confirmation or no-destructive filter |
| Config-mutating | `config set/unset` | Confirmation, redaction, audit |
| Provisioning | `up`, `apply` | Plan/review/apply + confirmation |
| Destructive | `destroy`, `down` | Explicit confirmation + audit |
| Remote execution | `ssh exec` | Strong opt-in + audit |

Deliverables:
- `docs/security/mcp-safety.md`
- `docs/security/tool-risk-matrix.md`
- `docs/security/redaction.md`
- `docs/security/audit-logs.md`
- `docs/mcp/read-only.md`

Status:
- [x] WO-07: MCP safety docs and tool risk matrix
- [x] WO-08: Read-only/no-destructive MCP setup docs
- [x] WO-09: Audit log examples and redaction guarantees

### R4 — Production Operations

Goal: make single-node OpenClaw deployments credible for ongoing use.

Work orders: WO-10 (operations guide), WO-11 (backup/restore validation plan), WO-12 (health check
expansion), WO-13 (upgrade/rollback design).

Deliverables:
- `docs/operations.md`
- `docs/upgrade-rollback.md`
- `docs/backup-restore.md`
- `docs/sizing.md`
- Deeper health checks (container running ≠ healthy)
- Log rotation and disk safety checks

Status:
- [x] WO-10: Operations guide
- [x] WO-11: Backup/restore validation plan
- [x] WO-12: Health check expansion
- [x] WO-13: Upgrade/rollback design

### R5 — Configuration and Secrets

Goal: make real OpenClaw configuration safe, inspectable, and less confusing.

Work orders: WO-14 (config validation design), WO-15 (secret redaction audit), WO-16 (model/channel
config wizard design).

Deliverables:
- `docs/configuration.md`
- `clawops config validate` command
- Actionable config error messages
- Secret source documentation
- Redaction test coverage

Status:
- [x] WO-14: Config validation design
- [x] WO-15: Secret redaction audit
- [x] WO-16: Model/channel config wizard design + implementation (`clawops setup`)

### R6 — Provider Reliability

Goal: show which provider paths are supported and prove the most important ones.

Work orders: WO-17 (provider capability matrix), WO-18 (local VM e2e test harness), WO-19 (provider
troubleshooting docs).

Deliverables:
- `docs/providers/matrix.md`
- Provider troubleshooting docs per provider
- Local VM end-to-end test (real SSH, real bootstrap, real health check)

Status:
- [x] WO-17: Provider capability matrix
- [ ] WO-18: Local VM end-to-end test harness
- [x] WO-19: Provider troubleshooting docs

### R7 — Developer Experience

Goal: make external contribution safer and easier.

Work orders: WO-20 (contributor workflow docs), WO-21 (generated spec workflow docs).

Deliverables:
- Improved `CONTRIBUTING.md`
- Provider adapter template
- Command template
- Generated-file check docs

Status:
- [x] WO-20: Contributor workflow docs
- [x] WO-21: Generated spec workflow docs

### R8 — Adoption and Launch

Goal: make the repository easy to evaluate, share, and launch.

Work orders: WO-22 (public roadmap + limitations), WO-23 (demo script), WO-24 (launch issue set).

Launch readiness requires R1 Wave 1 complete, at minimum: WO-01 (README), WO-04 (plan/apply
semantics), WO-22 (public roadmap), WO-17 (provider matrix). Full soft launch additionally requires
R3 (MCP safety docs) complete.

Deliverables:
- `docs/roadmap.md` (public)
- `docs/limitations.md`
- `docs/comparisons.md`
- Demo script (`examples/demo.sh` or `docs/demo.md`)
- GitHub issue templates and seeded issues

Status:
- [x] WO-22: Public roadmap and limitations
- [ ] WO-23: Demo script
- [ ] WO-24: Launch issue set

### R10 — Stack Monitoring

Goal: give operators a live, interactive view of a running OpenClaw stack's health, resource usage, and recent activity — without leaving the terminal.

Work orders: WO-26 (`clawops monitor` command), WO-27 (MCP monitor tool).

Background: `clawops doctor` and `clawops status` provide point-in-time snapshots. Operators running production stacks need continuous visibility — gateway reachability, model latency, active agent sessions, and log streams — surfaced in a single interactive command.

Deliverables:

**WO-26 — `clawops monitor` interactive wizard**

`clawops monitor [--stack <name>] [--interval <seconds>]`

A refreshing terminal dashboard that shows:
- **Gateway health**: reachability, uptime, port, auth mode
- **Active sessions**: connected agent count, session IDs, duration
- **Model usage**: requests/min, error rate, per-provider latency (last 5 min)
- **Container status**: image tag, restart count, memory/CPU (via `docker stats`)
- **Recent log tail**: last N lines from the OpenClaw container, auto-scrolling
- **Alerts**: surfaces config issues found by `clawops doctor` inline

Interaction model:
- Polls on a configurable interval (default 10s); renders via ANSI terminal output
- `q` / `Ctrl-C` exits cleanly (no process hang — calls `drainPool()`)
- `r` forces an immediate refresh
- `l` toggles the log tail panel on/off
- `d` runs a full `clawops doctor` check and displays results inline

Implementation notes:
- Reuses the SSH pool (`acquireSession`) for all remote execs; single session per refresh cycle
- Uses existing `readRemoteConfig`, `doctor` check helpers, and `clawops logs` infrastructure
- Renders with ANSI escape codes (no heavy TUI dependency); falls back to plain-text if `--no-color`

**WO-27 — MCP monitor tool**

`clawops_monitor` MCP tool: returns a structured JSON snapshot (gateway health, session count, model usage, last 5 log lines) that an agent can poll or summarise. Complements the interactive CLI by giving agents a machine-readable health signal.

Status:
- [ ] WO-26: `clawops monitor` interactive dashboard
- [ ] WO-27: `clawops_monitor` MCP tool

### R9 — Secret Lifecycle Management

Goal: give operators a first-class way to create, rotate, and audit secrets without manually editing files or rerunning the full setup wizard.

Work orders: WO-25 (secret lifecycle CLI).

Background: the `clawops setup` wizard stores pasted secrets in `~/.clawops/secrets/<NAME>` (chmod 600) and references them via `$secret:<NAME>` in config overlays. This works for single-operator use but has no rotation path and no visibility into which secrets are stale or missing.

Deliverables:
- `clawops secret list` — show all known secret names, their source type, and whether the ref is currently resolvable
- `clawops secret set <name>` — create or update a secret (paste, env var ref, or file path); propagates to any running stack via config overlay re-apply
- `clawops secret delete <name>` — remove a local secret file; warns if the secret is still referenced in any stack config
- `clawops secret rotate <name>` — shorthand for `set` followed by automatic config overlay re-apply and gateway restart on all stacks that reference the secret
- `clawops secret audit` — scan all stack configs for unresolved `$secret:` refs and secrets whose source file or env var is missing
- `docs/secrets.md` — document the full secret lifecycle: creation, rotation, deletion, and the manual fallback procedure for secrets that cannot be auto-rotated (e.g. cloud SM sources)

Status:
- [ ] WO-25: Secret lifecycle CLI and docs

### R11 — Gateway-Agent MCP Wiring

Goal: let the AI agent running *inside* an OpenClaw gateway control clawops management commands (doctor, status, config, logs) via MCP — without the user leaving the chat interface.

Work orders: WO-28 (gateway-side MCP client config).

Background: the `clawops setup` wizard already wires local AI editors (Claude Desktop, Cursor, etc.) to clawops via an MCP server entry in the editor's config. This wave adds the complementary wiring: the OpenClaw gateway's own AI agent becomes an MCP *client* of clawops, so in-conversation commands like "check if my stack is healthy" or "show me the last 20 log lines" invoke the real `clawops` CLI rather than hallucinating output.

Deliverables:

**WO-28 — Gateway-agent MCP client config**

New optional wizard step in `clawops setup` (and as a standalone `clawops mcp wire --stack <name>`):

1. Detect whether the deployed gateway's OpenClaw version supports MCP client connections (read `meta.lastTouchedVersion` from remote config; require ≥ 2026.4).
2. Prompt: *"Should the OpenClaw gateway's AI also be able to manage this stack?"* (default: no — opt-in only).
3. If yes, write an MCP client entry into the remote `openclaw.json` under `gateway.mcpClients`:
   ```json
   "mcpClients": {
     "clawops": {
       "command": "clawops",
       "args": ["mcp", "serve"],
       "transport": "stdio"
     }
   }
   ```
4. Call `restartGateway` to apply the change.
5. Show a confirmation: *"The gateway's AI can now run clawops commands. Try: 'check if my stack is healthy'"*.

Implementation notes:
- Use `atomicWriteConfig` + `restartGateway` (existing helpers) — no new SSH primitives needed.
- The MCP server for gateway use runs **without** `--read-only` (the gateway agent needs write access for config updates and gateway restarts).
- If the gateway's OpenClaw version does not support `mcpClients`, surface a clear version-upgrade message rather than silently failing.
- Add a `clawops mcp wire --stack <name>` command as a standalone entry point (not just via setup wizard) so operators can add this to existing deployments without re-running full setup.

Status:
- [ ] WO-28: Gateway-agent MCP client config (wizard step + standalone command)

---

## 16. Anti-Goals (deliberately not doing)

- **No web UI in v1.** Even a tiny one creates a maintenance burden disproportionate to value vs. the agent integration path.
- **No multi-region failover** in v1. Single-region per stack; multi-stack for HA.
- **No custom OpenClaw fork or build pipeline.** clawops uses upstream OpenClaw releases only.
- **No native Windows.** WSL2 is the supported path. Saves ~3 weeks of test matrix.
- **No `clawops` as a daemon.** It's a CLI + MCP server. No persistent process beyond the user's shell session and the MCP server (which lives only as long as the client keeps it open).
- **No automatic secret rotation in v1.** Planned for Wave 9 (WO-25). Manual rotation procedure is documented in `docs/secrets.md` (Wave 9 deliverable) in the meantime.
- **No spec changes without ADR.** R-meta-3 is binding.
