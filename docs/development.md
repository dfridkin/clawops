# Development Guide — Your First Five PRs

This guide is for engineers picking up clawops fresh, whether you're the first one in or joining a team that's already underway. It walks through five concrete PRs that get you productive.

## Before You Start

Read in this order, ~30 minutes total:

1. `README.md` — project map
2. `PRD.md` § 1, 3, 4 — what we're building and why
3. `SPEC.md` § 1, 2 — repo structure and architecture
4. `DESIGN_RULES.md` — the 25 rules (skim; you'll re-read on demand)
5. `CLAUDE.md` — what Claude Code expects when you open the repo

Then do a clean install:

```bash
git clone <repo>
cd clawops
pnpm install
pnpm gen:schemas
pnpm test
```

If any of those fail, fix them before proceeding (file an issue if needed).

## PR 1: Bootstrap the Project (M0 deliverable)

**Goal:** repo has all scaffolding files, CI is green on an empty `src/`.

**Scope:**
- Run the `/bootstrap` skill (or follow it manually)
- Verify all files in the bootstrap skill checklist exist
- `pnpm install`, `pnpm test`, `pnpm typecheck`, `pnpm lint` all green
- CI workflow runs on the PR

**Exit criteria:**
- [ ] All scaffolding files present
- [ ] `pnpm test` passes (no tests yet, but framework loads)
- [ ] `pnpm typecheck` passes on empty `src/index.ts`
- [ ] `pnpm gen:schemas` runs successfully and produces generated files
- [ ] CI job shows green checkmark

**Estimated time:** 1 day.

## PR 2: Output module + `--version` + `--json` (M0 vertical slice)

**Goal:** prove the entire output contract works end-to-end with a trivial command.

**Scope:**
- `src/output/human.ts` — pretty-print + spinners
- `src/output/json.ts` — `{ ok, data, error }` schema
- `src/output/table.ts` — ASCII table renderer (used later by status, list)
- `src/cli/index.ts` — citty wiring with global flags `--json`, `--quiet`, `--profile`, `--stack`
- `src/cli/commands/version.ts` — read package.json, return version
- Tests: output formatters, version command (human + json modes)

**Why this PR:** the output module is the contract every other command relies on. Building it first means every subsequent command can be tested for output correctness from PR #1.

**Exit criteria:**
- [ ] `pnpm dev --version` prints version (human mode)
- [ ] `pnpm dev --version --json` returns `{ "ok": true, "data": { "version": "0.0.0" } }`
- [ ] No `console.log` outside `src/output/` (lint enforced)
- [ ] Test coverage on output module ≥ 90%

**Estimated time:** 1-2 days.

## PR 3: Configuration plumbing (M0 → M1 bridge)

**Goal:** `~/.clawops/config.json` reading, writing, and the precedence chain from ADR 0004.

**Scope:**
- `src/config/store.ts` — read/write config file with conf
- `src/config/resolve.ts` — implement the `flag > env > config > default` chain
- `src/config/types.ts` — config file schema (use Zod)
- `src/cli/commands/init.ts` — non-interactive mode only for now
- `src/cli/commands/doctor.ts` — checks config validity, reports resolved values + sources
- Tests: precedence permutations, doctor output

**Why this PR:** every command depends on `--stack`/`--profile` resolution. Get this right once, refer to it everywhere.

**Exit criteria:**
- [ ] `clawops init --provider gcp --state gs://bucket/clawops --non-interactive` writes valid config
- [ ] `clawops doctor` reports config status with sources
- [ ] `clawops doctor --json` returns structured output
- [ ] Tests cover all five layers of precedence

**Estimated time:** 2-3 days.

## PR 4: GCP adapter scaffold (M1 first half)

**Goal:** the smallest possible end-to-end path. `clawops up --provider gcp --dry-run` produces a Pulumi preview without errors.

**Scope:**
- Use `/add-provider` skill to scaffold `src/providers/gcp/`
- `src/pulumi/automation.ts` — wrapper around `LocalWorkspace.createOrSelectStack`
- `src/pulumi/components/server.ts` — first component (just a Compute Engine VM)
- `src/cli/commands/up.ts` — wires it together
- Tests: provider adapter satisfies schema, Pulumi mock test for component

**Why this PR:** GCP first because the adapter is simplest; AWS has more IAM complexity. Dry-run only because real provisioning needs credentials and budget approval.

**Exit criteria:**
- [ ] `clawops up --provider gcp --dry-run --stack test` runs without errors against a configured GCP project
- [ ] Pulumi preview output is captured and rendered
- [ ] Schema conformance test passes (provider adapter satisfies `spec/providers.schema.json`)
- [ ] Component test passes with `pulumi.runtime.setMocks()`
- [ ] No real GCP API calls in unit tests (verified via lint rule + nock)

**Estimated time:** 3-5 days.

## PR 5: MCP server skeleton + first tool (M5 preview)

**Goal:** `clawops mcp serve` starts, registers `clawops_status` (read-only), responds to `tools/list` correctly.

**Scope:**
- `src/mcp/server.ts` — McpServer init, stdio transport
- `src/mcp/tools/_generated.ts` — emit from `spec/mcp-tools.yaml` via `gen-schemas.ts`
- `src/mcp/tools/cli/status.ts` — first concrete handler (delegates to `cli/commands/status.ts`)
- `src/mcp/audit.ts` — audit logger with redaction
- `src/cli/commands/mcp.ts` — `clawops mcp serve [--inspector]`
- Tests: tools/list shape, tool invocation with mocked status, audit log entry, stdio purity (I7)

**Why this PR:** establishes the MCP layer before all CLI commands are built, so subsequent commands can be exposed as tools immediately as they're added.

**Exit criteria:**
- [ ] `clawops mcp serve` runs (manual smoke test)
- [ ] `clawops mcp serve --inspector` opens MCP Inspector
- [ ] `clawops mcp install --claude` writes correct config block
- [ ] `clawops_status` tool callable with valid input
- [ ] Stdio purity test passes (no stdout writes outside protocol, R15)
- [ ] Audit log entry is sanitized

**Estimated time:** 4-5 days.

---

## After the First Five

You're now productive. Pick from the M1-M7 milestones in PRD.md §7.

Suggested ordering for PRs 6-10:

6. M1: GCP `up` (real provisioning, no longer dry-run)
7. M1: GCP `down --destroy`
8. M1: GCP `status`, `ssh`, `logs`
9. M2: SSH transport hardening + `tunnel`
10. M2: Remote OpenClaw config CRUD

## Tips

- **Use the skills.** `/add-provider`, `/mcp-tool`, `/pulumi-component`, `/tdd`, `/changeset`. They encode the patterns we want.
- **Read the relevant `.claude/rules/*.md`** for the area you're touching. They auto-load.
- **Pulumi mock type strings are exact.** If a component test passes without doing anything, your mock type string is wrong.
- **Stdio mode means NO `console.log`.** The lint rule catches this; trust it.
- **Schema first, code second.** Updating `spec/*` and running `pnpm gen:schemas` is faster than writing types by hand.
- **Failing test first.** The `/tdd` skill enforces it; the PostToolUse hook gives feedback.

## When You Get Stuck

- Search the ADRs in `docs/decisions/` — your question may already have a decision recorded
- Check `DESIGN_RULES.md` — the rule may explain why something is the way it is
- Open a GitHub Discussion before opening a PR with a contentious change

Welcome aboard.
