# clawops

clawops is a TypeScript CLI that generates and applies infrastructure to deploy
self-hosted OpenClaw across AWS, GCP, Azure, and local VMs. It uses the Pulumi
Automation API (embedded engine, not user-installed) and exposes its operations
as both a CLI surface and an MCP server so Claude Code, Cursor, and other agents
can drive deployments deterministically.

## Directory map

- `src/cli/`         citty-based commands (one file per verb in `commands/`)
- `src/providers/`   one folder per cloud; each implements `ProviderAdapter` (`src/providers/types.ts`, GENERATED from `spec/providers.schema.json`)
- `src/pulumi/`      Pulumi components + Automation API wrapper. URN convention: `clawops:<cat>:<Name>` where category ∈ {infra, build, net, app, state}
- `src/mcp/`         MCP server, tool definitions auto-generated from `spec/mcp-tools.yaml`
- `src/transport/`   SSH (uses `ssh2`). Never shell out to `/usr/bin/ssh`
- `src/plan/`        Maker plan generation, validation (`ajv` against `spec/deploy-plan.schema.json`), apply
- `src/config/`      `~/.clawops/config.json` management (no secrets — see R6)
- `spec/`            machine-readable specs (JSON Schema, YAML). Treat as ground truth (R-meta-1)
- `docs/`            narrative architecture, ADRs, per-provider guides
- `.claude/skills/`  invokable procedures (`/add-provider`, `/release`, `/openclaw-config`, `/tdd`)
- `.claude/rules/`   path-scoped rules loaded on demand

## Commands

- `pnpm dev`            run CLI from src
- `pnpm build`          tsup build to dist/
- `pnpm test`           vitest, parallel
- `pnpm test:changed`   vitest --changed; use this during edit loops
- `pnpm typecheck`      tsc --noEmit
- `pnpm lint`           eslint --max-warnings=0
- `pnpm gen:schemas`    emit `src/providers/types.ts` and `src/mcp/tools/_generated.ts` from `spec/`
- `pnpm gen:schemas --check`   CI check that committed generated files match spec
- `pnpm changeset`      record a release note (see `/release` skill)

## Invariants — YOU MUST follow these

- **Never store cloud credentials in clawops config.** Reference local CLI profiles
  (`AWS_PROFILE`, `HCLOUD_TOKEN` env, gcloud ADC). If you need to read a secret,
  document where the user provides it. (R6)
- **Never apply infrastructure directly from natural-language input.** Always go
  through the Maker plan flow: emit JSON matching `spec/deploy-plan.schema.json`,
  persist it, let user review, then `clawops apply <plan.json>`. (Borrowed from Clanker pattern; F5–F6)
- **All ProviderAdapter implementations satisfy the interface in
  `src/providers/types.ts` AND the JSON Schema in `spec/providers.schema.json`.**
  If the schema says a field is required, add it; do not relax the schema. (R-meta-1)
- **All MCP tools are declared in `spec/mcp-tools.yaml` first.** The Zod schemas in
  `src/mcp/tools/_generated.ts` are GENERATED from that file; do not hand-edit them. (R-meta-1)
- **Every MCP tool sets all four annotation hints** (`readOnlyHint`,
  `destructiveHint`, `idempotentHint`, `openWorldHint`) plus `title`. Defaults are insufficient. (R10)
- **Default security-group/firewall rules are deny-all.** Never default `0.0.0.0/0`
  on SSH or gateway ports. (N10)
- **Tests for cloud SDKs use `@aws-sdk/client-mock` or `nock`** — never call real
  APIs in unit tests. Pulumi components use `pulumi.runtime.setMocks()`.
- **Stdio MCP servers must never write to stdout** outside the protocol. Use
  `process.stderr.write` for logs or `notifications/message`. (R15)
- **Output trim before MCP return.** Pulumi raw JSON output exceeds context
  budgets; summarize and expose full output as a resource. Cap at 8KB. (R14)
- **Conventional commits** (`feat`/`fix`/`docs`/`refactor`/`chore`/`test`/`perf`/`ci`).
  The `/release` skill enforces this.

## Style

- TypeScript strict everywhere. No `any` without an inline `// eslint-disable-next-line` and a comment.
- Prefer `Result<T, E>` over throwing in adapters; throw at the CLI boundary only.
- Async I/O: AbortSignal everywhere there's a network call. (R13)
- All paths absolute. Server records launch CWD once and ignores it. (R7, R17)

## Where to find things

- "How do I add a provider?" → `/add-provider` skill, or `src/providers/CLAUDE.md`
- "How do I add an MCP tool?" → `/mcp-tool` skill, or `spec/mcp-tools.yaml`
- "How do I add a Pulumi component?" → `/pulumi-component` skill, or `src/pulumi/CLAUDE.md`
- "How do I cut a release?" → `/release` skill
- Architecture overview, decisions → `docs/architecture.md`, `docs/decisions/`
- Normative rules (R1–R25, R-meta-*) → `DESIGN_RULES.md`
- Why we chose X over Y → `docs/decisions/00NN-*.md`

## Quirks

- Pulumi Automation API has a known-bad interaction with pnpm hoisting; pin
  `@pulumi/pulumi` at top level. See `docs/decisions/0003-pulumi-pnpm-hoisting.md`.
- OpenClaw 2026.4.5+ requires `AWS_PROFILE` in the systemd `EnvironmentFile`, not
  `auth: "aws-sdk"` in `openclaw.json`. The aws provider must emit both for
  compatibility. Tracked in `spec/openclaw-versions.yaml`.
- `clawctl.com` is an unrelated managed-hosting SaaS — do not confuse with this
  project. We are `clawops` (npm: `@clawops/cli`, MCP package: `@clawops/mcp-server`).
- Pulumi mocks: type tags must match the *exact* Pulumi resource type string
  (e.g., `aws:ec2/instance:Instance` not `aws:ec2:Instance`). Bug magnet.

## When you make a change that violates a rule

You must add an ADR under `docs/decisions/` per R-meta-3 explaining (1) which
rule, (2) why the violation is justified, (3) what mitigation applies, (4) when
to revisit.
