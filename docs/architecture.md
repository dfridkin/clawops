# clawops Architecture

This document is the narrative companion to SPEC.md. SPEC.md tells you *what* the system is; this document tells you *why* it's structured the way it is and *how* the pieces fit together.

## 1. Mental Model

clawops is best understood as **three concentric surfaces** wrapping a deterministic core:

```
┌──────────────────────────────────────────────────────────────┐
│  Surface 1: Human CLI                                         │
│  $ clawops up --provider aws                                  │
│                                                               │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Surface 2: Agent MCP                                   │  │
│  │  Claude Code → clawops_workflow_deploy_app(...)         │  │
│  │                                                          │  │
│  │  ┌──────────────────────────────────────────────────┐  │  │
│  │  │  Surface 3: Programmatic API                       │  │  │
│  │  │  import { Provisioner } from 'clawops'             │  │  │
│  │  │                                                     │  │  │
│  │  │  ┌──────────────────────────────────────────────┐ │  │  │
│  │  │  │  Core: Plan → Apply → State                   │ │  │  │
│  │  │  │  Maker plan + Pulumi engine + cloud blob      │ │  │  │
│  │  │  └──────────────────────────────────────────────┘ │  │  │
│  │  └──────────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

Each surface adds a different shape of input/output to the same deterministic core. The core never knows which surface called it. This is how we get CLI parity with the MCP server "for free" — both layers translate to the same internal `PlanRequest` / `ApplyRequest` / `StatusRequest`.

## 2. Why Pulumi Automation API (Not Terraform / Direct SDK)

We considered three approaches:

1. **Direct cloud SDKs** (`@aws-sdk`, `@google-cloud/*`, `@azure/arm-*`) — fastest cold-start, no extra deps. Rejected because we'd reimplement state tracking, drift detection, and resource ordering — about 60% of what Pulumi gives us.

2. **Terraform via shellout** — well-known, huge module ecosystem. Rejected because (a) requires user to install Terraform, (b) no programmatic state inspection, (c) HCL templating from TS is awkward.

3. **Pulumi Automation API (embedded engine)** — chosen. Pulumi as a TypeScript library means inline programs (no `pulumi.yaml` on disk), in-process state, native typed outputs. Cost: ~50MB bundle increase. Worth it.

The Automation API specifically (vs. requiring `pulumi` CLI) is the unlock — see ADR 0006.

## 3. The Maker Pattern (Borrowed from Clanker)

Every destructive operation routes through a reviewable plan artifact:

```
┌────────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│ Intent     │────▶│ Generate │────▶│ Review   │────▶│ Apply    │
│ (natural   │     │ Plan     │     │ Plan     │     │ Plan     │
│  language  │     │ (JSON)   │     │ (human/  │     │ (Pulumi  │
│  or flags) │     │          │     │  agent)  │     │  engine) │
└────────────┘     └──────────┘     └──────────┘     └──────────┘
```

**Why this matters:**

- **Auditability**: every change has a reviewable artifact in CI/git
- **Determinism**: applying yesterday's plan today produces the same diff (modulo upstream API changes)
- **Agent safety**: an LLM can't directly destroy infrastructure — it can only generate a plan that a human or elicitation flow approves

The plan format is `spec/deploy-plan.schema.json`. The Maker flow is enforced by all destructive MCP tools (R19) and is the *only* path the `apply` command takes.

## 4. Layered Architecture

### 4.1 Layers from Top to Bottom

| Layer | Responsibility | Module Path |
|---|---|---|
| **Surface adapters** | Translate user/agent input into internal request types | `src/cli/`, `src/mcp/` |
| **Command handlers** | Orchestrate one verb's work | `src/cli/commands/`, `src/mcp/tools/cli/` |
| **Workflow orchestrators** | Compose multiple commands into user-intent flows | `src/mcp/tools/workflow/` |
| **Plan engine** | Generate, validate, and apply Maker plans | `src/plan/` |
| **Pulumi engine** | Stack lifecycle via Automation API | `src/pulumi/automation.ts` |
| **Provider adapters** | Cloud-specific provisioning | `src/providers/<name>/` |
| **Pulumi components** | Reusable infrastructure abstractions | `src/pulumi/components/` |
| **Transport** | SSH, log streaming, file transfer | `src/transport/` |
| **State backend** | Pulumi-managed cloud blob | (external; configured via `clawops init`) |
| **Foundation** | Output formatting, config, errors | `src/output/`, `src/config/`, `src/errors/` |

### 4.2 Inter-Layer Rules

- A higher layer may call lower layers freely.
- A lower layer must NEVER reference a higher layer.
- Cross-layer at the same level (e.g., one provider importing from another) is forbidden.
- The output layer (`src/output/`) is the ONLY place that writes to stdout/stderr (R15).

## 5. Provider Adapter Architecture

Each provider implements `ProviderAdapter` (generated from `spec/providers.schema.json`) and lives in its own folder:

```
src/providers/aws/
├── adapter.ts        # default export, satisfies ProviderAdapter
├── config.ts         # validates AWS_PROFILE, region, etc. at startup
├── pulumi.ts         # the inline Pulumi program closure
├── instance-types.ts # alias → t3.small / g4dn.xlarge / etc.
├── errors.ts         # AwsCredentialsError, AwsQuotaError, etc.
├── secrets.ts        # SSM Parameter Store integration
└── index.ts          # re-export
```

The **inline Pulumi program** is the heart of each adapter — a TypeScript closure that, when invoked by the Pulumi engine, declares all the resources for one stack:

```typescript
// src/providers/aws/pulumi.ts (illustrative)
export function awsProgram(opts: ProgramOpts): pulumi.automation.PulumiFn {
  return async () => {
    const sg = new aws.ec2.SecurityGroup(/* ... */);
    const eip = new aws.ec2.Eip(/* ... */);
    const instance = new aws.ec2.Instance(/* ... */);
    const server = new components.Server(/* ... */);
    const gateway = new components.Gateway(/* ... */);
    return {
      gatewayUrl: pulumi.interpolate`https://${eip.publicIp}:18789`,
      sshHost: eip.publicIp,
      // ...
    };
  };
}
```

This is what gets passed to `LocalWorkspace.createOrSelectStack({ program })`.

## 6. The MCP Layer

### 6.1 Why a Single Tool Catalog (`spec/mcp-tools.yaml`)

Authoring tools in YAML, generating Zod schemas in TS, has three benefits:

1. **Single source of truth** — the catalog can't drift from the implementation
2. **Auditable** — adding a tool is a YAML diff, reviewable
3. **R1 enforcement** — counting tools, checking prefixes, validating annotations is mechanical

### 6.2 Toolsets (R1)

The four toolsets exist because different use cases need different surface areas:

- **`cli`**: someone wiring clawops into their own agent wants the full surface
- **`read`**: someone running clawops in `--read-only` mode (e.g., for debugging or auditing) gets only this subset
- **`workflow`**: an agent doing high-level deployment wants composite tools
- **`admin`**: multi-stack management is a sharp tool you don't want enabled by default

### 6.3 Transport Modes

`clawops mcp serve` ships two transport modes in `@clawops/cli`:

- **stdio (default):** single-user, stateful, shares process with the CLI. Used by Claude Desktop, Cursor, VS Code via local config.
- **HTTP (`--http`):** Streamable HTTP, stateless toggle (`--stateless`), OAuth 2.1 resource server. Used for team-wide or multi-tenant MCP infrastructure.

## 7. State Management

State lives in cloud blob storage (`s3://`, `gs://`, `azblob://`, or `file://` for local). Pulumi manages the actual files; we just configure the backend URL.

```
s3://my-bucket/clawops/
└── .pulumi/
    └── stacks/
        └── clawops/
            ├── default.json       # stack: default
            ├── prod-aws.json
            └── staging-gcp.json
```

**Why per-project blob storage instead of Pulumi Cloud?**

- No mandatory cloud account / billing
- Lives in the user's own cloud, with their own access controls
- No "is Pulumi Cloud up?" dependency
- Aligns with R6 (credentials never in clawops's hands)

**Drift detection** is via `clawops refresh` which calls `stack.refresh()` and reports the diff.

## 8. Security Architecture

The security model rests on five pillars (R6, R10–R11, R18–R22):

1. **Credentials never in clawops's hands** (R6). All cloud auth happens via the cloud's native mechanism: env vars, CLI profiles, instance metadata.
2. **Default deny, explicit allow** (N10). Generated firewalls allow nothing until the user specifies CIDRs.
3. **Plan-then-apply** (Maker pattern). No direct destructive paths.
4. **Filter at registration** (R18). `--read-only` mode doesn't soft-block destructive tools — they don't exist.
5. **Audit everything** (R21). Every MCP tool call writes a sanitized JSON log entry.

The five-layer egress defense from schmitthub/openclaw-deploy is documented as a *reference architecture* but not the default. Users opting into the secure profile via `clawops up --profile secure` get Tailscale + Envoy + UFW + DNS allowlist; the default profile is simpler.

## 9. Observability

Three signals:

- **Logs** — structured JSON to stderr, library is `pino` (see ADR 0007). Fields per logging spec.
- **Metrics** — OpenTelemetry export optional (`OTEL_EXPORTER_OTLP_ENDPOINT`). Tool-call duration, plan apply duration, error rates.
- **Traces** — also OTel. Useful for debugging the Pulumi engine ↔ provider ↔ SSH chain.

All telemetry is opt-in. Default is logs-only.

## 10. Testing Strategy

Three test layers, each catching different bugs:

| Layer | What it catches | Speed | Coverage target |
|---|---|---|---|
| **Unit** (mocked SDKs) | Logic bugs, type bugs, schema conformance | <100ms each | 80% |
| **Pulumi mock tests** | Component wiring, output dataflow | <500ms each | 90% on components |
| **Integration** (Docker SSH, LocalStack) | Transport, real subprocess interaction | 5–30s each | 60% on transport |
| **E2E** (sandbox cloud) | Cloud API drift, real credentials | 5–10 min each | Smoke only |

The TDD skill enforces test-first; the `PostToolUse` hook gives instant feedback.

## 11. The Plan File Lifecycle

```
clawops plan          clawops apply <plan>
     │                       │
     ▼                       ▼
┌─────────┐            ┌──────────┐
│ stdout  │            │ Pulumi   │
│ or file │──reviewed─▶│ engine   │
└─────────┘            └──────────┘
                            │
                            ▼
                      ┌──────────┐
                      │ Cloud    │
                      └──────────┘
```

Plans are immutable artifacts. If the user wants to change something, they regenerate the plan; they don't edit it. (Editing is *technically* possible since it's JSON, but `apply` re-validates against the schema and any edits the user made must still validate.)

## 12. Extension Points

Three extension points for v1.0:

1. **Add a provider** → `/add-provider` skill, implements `ProviderAdapter`
2. **Add an MCP tool** → `/mcp-tool` skill, declared in `spec/mcp-tools.yaml`
3. **Add a Pulumi component** → `/pulumi-component` skill, follows URN convention

Plugin interface for third-party providers is an explicit non-goal for v1.0 (revisit in v1.1+).

## 13. What This Architecture Is NOT

- **Not a Kubernetes operator.** That's openclaw-rocks/openclaw-operator's job. clawops is for VM-based deployments.
- **Not a hosted SaaS.** clawctl.com fills that niche.
- **Not a general-purpose cloud agent.** That's Clanker. clawops is OpenClaw-first.
- **Not a multi-region failover orchestrator.** Single-region per stack; multi-stack for HA.

## 14. Roadmap-Adjacent Architecture Decisions Deferred

For v1.1+:

- Plugin interface for third-party providers
- Web UI / TUI dashboard layered on top of MCP
- Kubernetes adapter (would wrap openclaw-rocks/openclaw-operator)
- OpenClaw upgrade orchestration with rollback
- Multi-stack fleet management

Each will get its own ADR when prioritized.

---

## References

- SPEC.md — technical specification
- DESIGN_RULES.md — normative implementation rules
- docs/decisions/ — historical reasoning
- spec/ — machine-readable schemas
