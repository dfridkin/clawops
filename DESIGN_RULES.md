# clawops Design Pattern Rules

**Status:** Normative. Every PR must comply or include an ADR explaining the deviation.
**Version:** 0.2

This document collects the design pattern rules distilled from the MCP infrastructure-server research, the Claude Code best practices research, and the OpenClaw deployment project deep dives. Every rule is numbered and can be cited in code reviews and ADRs (e.g., "this violates R5").

The rules are organized by concern. Each rule includes the rule itself, the rationale, and a reference to the source pattern observed in production tools (Pulumi MCP, Fly.io flyctl, HashiCorp Terraform MCP, Kubernetes MCP servers, schmitthub/openclaw-deploy, Clanker).

---

## Tool Surface (R1–R4)

### R1 — Dual-surface, prefixed, toolset-grouped

Every MCP tool name is prefixed with `clawops_` and assigned to a toolset (`cli`, `workflow`, `read`, `admin`). Toolsets are independently enableable via `--toolsets` flag. **Hard cap: 30 tools registered at any time.**

*Rationale:* Cursor caps at 40 enabled MCP tools; agents degrade past ~30. Toolsets let users opt into the surface area they need without pollution.

*Source:* GitHub MCP server, Kubernetes MCP servers — observed `--toolsets` pattern.

### R2 — Composite tools encode user intent, not API sequences

A composite `clawops_workflow_*` tool exists only if it represents a single coherent user goal (e.g., `clawops_workflow_deploy_app`). **Never ship `step_1` / `step_2` decomposed tools.**

*Rationale:* Agents skip or repeat ordered steps. Either fuse the workflow or expose primitives independently — never both as a workflow.

*Source:* Anthropic skill design guidance; Pulumi MCP `deploy-to-aws` composite.

### R3 — Negative guidance in descriptions

Every tool description includes both *when to use* and *when NOT to use*, naming the alternative tool when applicable.

*Rationale:* Tool selection accuracy improves measurably with negative examples. Pulumi's `get-stacks` description literally instructs agents to use `resource-search` instead for filtering.

*Source:* Pulumi MCP server tool descriptions.

### R4 — Resources for read-only state, prompts for templates

Current context, available regions, stack outputs → MCP resources, not tools. Workflow templates → MCP prompts. **Reserve the tool-slot budget for verbs.**

*Rationale:* Resources and prompts don't consume tool-slot budget. Agent context windows are scarce; don't waste them on read-only data.

*Source:* MCP spec; Pulumi server's prompts (`deploy-to-aws`, `convert-terraform-to-typescript`).

---

## Schema (R5–R9)

### R5 — Self-contained tool calls

Every mutation tool accepts `stackName` as an optional argument with a startup default. **No hidden `set_current_stack` state machine.**

*Rationale:* Agents don't reliably track implicit state across long conversations. Self-contained calls are debuggable and testable.

*Source:* Pulumi MCP — `pulumi-cli-up` requires `workDir` per call, defaults `stackName` to `"dev"`.

### R6 — Credentials never in tool args

AWS profiles, Pulumi tokens, SSH keys read from environment at server startup. Region accepted as optional override, never as required input.

*Rationale:* Credentials in tool args end up in agent traces and chat logs. The LLM has no business choosing which AWS account to hit. Mirrors how every infra MCP server in the wild does it.

*Source:* Every infra MCP server surveyed (Pulumi, Terraform, Kubernetes, Fly.io, Ansible AAP).

### R7 — Absolute paths only

Any path argument (`workDir`, `--key-path`, `--plan-file`) must be absolute. Server resolves relative paths or errors clearly. **Never trust `process.cwd()`.**

*Rationale:* Stdio MCP servers launched by Claude Desktop have unreliable working directories (often `/` on macOS).

*Source:* MCP spec implementation notes; Pulumi server's `workDir` enforcement.

### R8 — Enums for closed sets

Provider names, instance type aliases, stack names (when known) use Zod enums, not strings.

*Rationale:* Improves agent selection accuracy materially. Zod runtime validation catches typos before they hit the cloud API.

*Source:* MCP TypeScript SDK conventions.

### R9 — Output schemas declared

Every tool declares an `outputSchema` so clients receive validated structured data, not free-form text.

*Rationale:* Available in `@modelcontextprotocol/sdk` v2; backportable to v1 with minor wiring. Eliminates hand-parsing of tool responses.

*Source:* MCP TS SDK v2.

---

## Annotations (R10–R11)

### R10 — Every tool annotated

All tools set `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`, and a human-readable `title`. **Defaults from the spec are insufficient — set them explicitly even for read tools.**

*Rationale:* Default `destructiveHint` is `true`; explicitly setting `false` on read tools fixes ChatGPT dev mode mis-flagging.

*Source:* MCP spec 2025-03-26; ChatGPT dev mode bug reports.

### R11 — Annotation-to-mode mapping is normative

- `readOnlyHint: true` → enabled in `--read-only` mode
- `destructiveHint: true` → wrapped with `ctx.elicit()` in `--require-confirmation` mode
- Combined `destructive + non-idempotent` → highest confirmation friction (full resource diff shown)

*Rationale:* Annotations alone are advisory. Binding them to enforced safety modes makes them actionable.

*Source:* Synthesis of MCP spec hints + Kubernetes MCP server safety modes.

---

## Long-Running Operations (R12–R14)

### R12 — Three-tier streaming model

- **<10s:** synchronous response only
- **10–60s:** synchronous + `notifications/progress`
- **>60s:** Tasks primitive (return `taskId` immediately, expose `clawops_task_status` polling tool)

*Rationale:* Most VM provisioning falls in the third tier. Tasks primitive (SEP-1686, MCP 2025-11-25) is the emerging standard.

*Source:* MCP spec; WorkOS async-tasks writeup; Pulumi Neo's `neo-bridge`/`neo-get-tasks` pattern.

### R13 — Cancellation is wired end-to-end

`ctx.signal` (AbortSignal) propagates to the underlying Pulumi/SSH/subprocess. SIGTERM on cancel; SIGKILL after 5s grace.

*Rationale:* Without end-to-end cancellation, MCP cancellation notifications are ignored by the actual cloud operation, leading to ghost resources.

*Source:* MCP cancellation spec; Node.js subprocess best practices.

### R14 — Output trimming is mandatory

Pulumi `up --json` output is summarized before return. Full output exposed as a fetchable resource (`clawops://stacks/{name}/last-run`). **Hard cap on tool result size: 8KB default, configurable.**

*Rationale:* A 50-resource stack's Pulumi output can exceed 100KB and destroy the agent's context window. Workato and Arcade list this as a top mistake.

*Source:* Workato/Arcade MCP design guides.

---

## State and Transport (R15–R17)

### R15 — Stdio for embedded, Streamable HTTP for remote

No HTTP+SSE (deprecated in MCP 2025-06-18). Stdio mode forbids stdout writes outside protocol. **All logging goes to stderr or `notifications/message`.**

*Rationale:* `console.log` in a stdio server corrupts the protocol. This bug is the single most common cause of "Claude Desktop can't connect to my MCP server."

*Source:* MCP spec stdio rules; community debugging reports.

### R16 — Stateful by default, stateless togglable

`clawops mcp serve` is stateful (single user, embedded). `@clawops/mcp-server` (production package) supports `--stateless` for HA / load-balanced deployments.

*Rationale:* Embedded use benefits from session continuity; production multi-tenant requires statelessness behind LBs.

*Source:* HashiCorp Terraform MCP, containers/kubernetes-mcp-server — both ship this toggle.

### R17 — Working-directory invariant

Server records its launch CWD once, ignores it for path resolution. All operations resolve from explicit args or config.

*Rationale:* See R7. Stdio servers cannot assume a meaningful CWD.

*Source:* MCP spec + Pulumi server practice.

---

## Security (R18–R22)

### R18 — Safety modes filter at registration, not runtime

`--read-only` and `--no-destructive` flags **omit destructive tools from `tools/list` entirely** — not soft-blocked at call time.

*Rationale:* Defense in depth: even if an agent is compromised or hallucinates a tool name, registration-time filtering prevents the call from existing.

*Source:* containers/kubernetes-mcp-server, Flux159/mcp-server-kubernetes.

### R19 — Elicitation before destruction

`clawops_destroy` and similar tools call `ctx.elicit()` with a structured form showing the resource diff before executing. **This is enforcement, not just UX.**

*Rationale:* Binding confirmation to the tool body (not the client) ensures even non-conformant clients can't bypass it.

*Source:* MCP elicitation primitive (2025-06-18 spec).

### R20 — Tokens never forwarded

clawops's MCP server uses its own service-account credentials to call cloud APIs. Client-supplied bearer tokens authenticate the *client*, never proxy upstream.

*Rationale:* The "confused deputy" anti-pattern. Explicitly prohibited in MCP June 2025 spec.

*Source:* MCP authorization spec.

### R21 — Audit log every tool call

Structured JSON to stderr: `{ts, sessionId, tool, args (sanitized), durationMs, result, error?}`. Cloud-deployed mode also ships to centralized log aggregation.

*Rationale:* Forensic capability for any agent misbehavior. Sanitization (drop `Authorization` headers, secret values, full ARNs) is mandatory.

*Source:* HashiCorp Terraform MCP OpenTelemetry; Flux159 K8s MCP audit pattern.

### R22 — Environment scoping over argument scoping

`prod` and `dev` use separate MCP server instances (or separate toolsets), not an `env` argument. **Reduces blast radius from agent error.**

*Rationale:* If the agent picks the wrong env in a tool argument, you've just deleted prod. If the agent only has access to a dev server, the worst case is bounded.

*Source:* AWS MCP guidance; production deployment patterns.

---

## Distribution (R23–R25)

### R23 — One-flag installation

`clawops mcp install --claude | --cursor | --vscode | --windsurf | --zed` writes the correct config block. Mirrors `flyctl`'s pattern.

*Rationale:* Friction-to-install is the single largest determinant of MCP adoption. Manual JSON config-file editing loses 50%+ of users.

*Source:* Fly.io's `fly mcp server --claude` UX.

### R24 — Inspector-first development

`clawops mcp serve --inspector` launches `@modelcontextprotocol/inspector` against the local server. **Required for any new tool before integration.**

*Rationale:* Catches schema/output errors before they reach Claude Desktop. The inspector is the canonical local debugger.

*Source:* MCP Inspector tool; Fly.io's `fly mcp server -i` shortcut.

### R25 — SDK pinning

Target `@modelcontextprotocol/sdk@1.29.x` on Node 20+. **v2 migration deferred until v2 docs indicate stability.**

*Rationale:* v2 is in active development on `main`; transport/middleware story still settling. v1 is battle-tested by every major server in production.

*Source:* MCP TS SDK release notes and migration guidance.

---

## Meta-Rules (Spec Discipline)

### R-meta-1 — Schema is ground truth

Machine-readable schemas in `spec/*.{json,yaml}` are the source of truth. TypeScript types in `src/providers/types.ts` and Zod schemas in `src/mcp/tools/_generated.ts` are **generated** from spec files via `pnpm gen:schemas`. CI fails if generated files drift.

### R-meta-2 — Word docs forbidden

No `.docx`, `.pages`, `.rtf` in the repo. CI deny-list enforces. All specs are Markdown + JSON Schema + YAML.

### R-meta-3 — ADRs for every R-rule deviation

Any PR that violates an R-rule must include an ADR under `docs/decisions/` explaining (1) which rule, (2) why the violation is justified, (3) what mitigation applies, (4) when revisiting.

### R-meta-4 — Tests assert against schemas

Provider adapter tests load `spec/providers.schema.json` via `ajv` and validate against it. Schema changes that break tests are intentional and require migration; silent drift is impossible.

---

## Quick Reference Card

| ID | One-line summary |
|---|---|
| R1 | Toolsets, `clawops_` prefix, ≤30 tools |
| R2 | Composite = user intent; no decomposed steps |
| R3 | Tool descriptions include "when NOT to use" |
| R4 | Read state = resources; templates = prompts |
| R5 | Self-contained tool calls; no hidden state |
| R6 | Credentials in env, never in args |
| R7 | Absolute paths only |
| R8 | Zod enums for closed sets |
| R9 | Output schemas always declared |
| R10 | All annotation hints set explicitly |
| R11 | Annotations bound to safety modes |
| R12 | Three-tier streaming (sync / progress / Tasks) |
| R13 | Cancellation propagates to subprocess |
| R14 | Trim outputs; full output as resource |
| R15 | Stdio embedded, Streamable HTTP remote |
| R16 | Stateful default; stateless togglable |
| R17 | Server ignores launch CWD |
| R18 | Safety modes filter at registration |
| R19 | Elicitation before destruction |
| R20 | Tokens never forwarded upstream |
| R21 | Audit-log every tool call (sanitized) |
| R22 | Scope by env (separate servers) |
| R23 | One-flag client installation |
| R24 | Inspector-first development |
| R25 | SDK pinned to v1.29.x on Node 20+ |
