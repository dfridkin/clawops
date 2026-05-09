# Contributing to clawops

Thank you for considering a contribution. This doc covers what you need to know.

## Quick Start

```bash
git clone https://github.com/<org>/clawops
cd clawops
pnpm install
pnpm gen:schemas
pnpm test
pnpm dev --help
```

## Prerequisites

- Node.js 20.x or 22.x (`.nvmrc` pins the recommended version)
- pnpm 9.x (`corepack enable` if you don't have it)
- A cloud account for end-to-end testing (sandbox tier is fine)

## Development Workflow

1. **Pick or create an issue.** "Good first issue" labels mark approachable tasks.
2. **Branch:** `git checkout -b <type>/<short-description>` (e.g., `feat/hetzner-provider`, `fix/ssh-tunnel-cleanup`)
3. **Read the relevant CLAUDE.md** for the area you're touching:
   - `src/providers/CLAUDE.md` for adapter work
   - `src/mcp/CLAUDE.md` for MCP work
   - `src/pulumi/CLAUDE.md` for component work
   - `.claude/rules/` files load automatically based on path
4. **Use the right Claude Code skill** for the task:
   - Adding a provider? → `/add-provider`
   - Adding an MCP tool? → `/mcp-tool`
   - Adding a Pulumi component? → `/pulumi-component`
   - Implementing a feature? → `/tdd` (test-first)
5. **TDD or close to it.** The `/tdd` skill walks through the discipline. Tests live under `tests/`.
6. **Add a changeset** (`pnpm changeset` or `/changeset` skill) for any user-visible change.
7. **Open a PR** using the template. Make sure CI is green.

## Code Style

- TypeScript strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` ON)
- No `any` without `// eslint-disable-next-line` and a comment explaining why
- Prefer `Result<T, E>` over throwing in adapters; throw at the CLI boundary only
- Async I/O: AbortSignal everywhere there's a network call
- All paths absolute (R7)
- Errors: subclass `ClawopsError` per ADR 0005, never raw `throw new Error()`

Lint catches most of this:
```
pnpm lint        # check
pnpm lint:fix    # fix what's auto-fixable
pnpm format      # prettier
```

## Commit Messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>

<body>

<footer>
```

Types: `feat`, `fix`, `docs`, `refactor`, `chore`, `test`, `perf`, `ci`

Examples:
- `feat(providers): add Hetzner Cloud adapter`
- `fix(mcp): handle stdio EOF correctly`
- `docs(adr): add 0008 on multi-region failover deferral`

## Testing

- **Unit tests:** mock cloud SDKs (`@aws-sdk/client-mock`, `nock`). Run with `pnpm test:changed` during dev.
- **Pulumi component tests:** use `pulumi.runtime.setMocks()`. See `tests/pulumi/components.test.ts`.
- **MCP tool tests:** invoke via in-memory client; assert schema conformance.
- **Integration tests:** Docker-based fixtures (see `tests/integration/`).
- **E2E:** opt-in workflow against sandbox cloud accounts.

Coverage targets per SPEC §11.4:
- 70% line overall
- 90% on Pulumi components
- 100% on `src/plan/validate.ts`

## Pull Request Checklist

The PR template includes a checklist. The high-bit items:

- [ ] Tests added or updated for the change
- [ ] `pnpm test`, `pnpm typecheck`, `pnpm lint` all pass locally
- [ ] `pnpm gen:schemas:check` passes (no spec/code drift)
- [ ] Changeset added (`pnpm changeset`) for user-visible changes
- [ ] No new violation of any R-rule (R1-R25, R-meta-*); if there is, ADR is included

## Design Rules (R1–R25)

`DESIGN_RULES.md` is normative. Violating an R-rule requires an ADR (`docs/decisions/`) explaining why and what mitigation applies. R-meta-3 is the meta-rule about this.

## Architecture Decision Records (ADRs)

When you make a non-trivial architectural decision, write an ADR:

1. Copy `docs/decisions/_template.md` (when authored) to the next number, e.g., `0008-some-decision.md`
2. Fill in: Context → Decision → Consequences → Verification
3. Link to it from any related code comments or PR description

Existing ADRs:
- 0001 — clawops naming, supersede Word doc
- 0002 — schmitthub vendor strategy
- 0003 — Pulumi pnpm hoisting
- 0004 — config precedence
- 0005 — error taxonomy
- 0006 — embedded Pulumi engine
- 0007 — logging library

## Adding a Provider

`/add-provider` skill walks through the full process. High-level:

1. Update `spec/providers.schema.json` if adding a new provider name to the enum
2. Run `pnpm gen:schemas` — updates `src/providers/types.ts` automatically
3. Copy `src/providers/_adapter-template.ts` to `src/providers/<name>/index.ts`; fill in every `<PLACEHOLDER>`
4. Write `src/providers/<name>/program.ts` — the inline Pulumi program
5. Write tests with mocked SDK (see `tests/providers/aws/` as reference)
6. Document in `docs/providers/<name>.md` (copy `docs/providers/_template.md`)
7. Update `docs/providers/matrix.md` with the new column
8. Add a changeset (minor severity)

See `docs/generated-files.md` for how `pnpm gen:schemas` fits into the workflow.

## Adding a CLI Command

1. Copy `src/cli/commands/_command-template.ts` to `src/cli/commands/<verb>.ts`; fill in every `<PLACEHOLDER>`
2. Register the command in `src/cli/index.ts → subCommands`
3. Add a matching MCP tool in `spec/mcp-tools.yaml` if the command should be agent-accessible, then run `pnpm gen:schemas`
4. Write tests in `tests/cli/<verb>.test.ts`
5. Update `README.md` commands table + relevant docs section
6. Add a changeset

## Adding an MCP Tool

`/mcp-tool` skill walks through. High-level:

1. **Check the budget first.** R1 caps tools at 30. If at the limit, talk through which to deprecate or merge.
2. Add to `spec/mcp-tools.yaml` with all annotations and descriptions including "Do NOT use" guidance (R3)
3. Run `pnpm gen:schemas` — see `docs/generated-files.md`
4. Implement the handler in `src/mcp/tools/<toolset>/<name>.ts`
5. Wire into `src/mcp/tools/registry.ts`
6. Tests + changeset

## Generated Files

`src/mcp/tools/_generated.ts` and `src/providers/types.ts` are generated from specs in `spec/`.
Never hand-edit them. See `docs/generated-files.md` for the full workflow.

## Reporting Bugs

Use the issue template for bug reports. Include:

- clawops version (`clawops version`)
- Node version (`node --version`)
- Provider + region
- Output of `clawops doctor` (sanitized)
- Reproduction steps
- Expected vs. actual behavior

## Reporting Security Issues

**Do not file security issues publicly.** See `SECURITY.md` for the disclosure process.

## License

By contributing, you agree your contributions are licensed under MIT. See `LICENSE`.

## Code of Conduct

We follow the Contributor Covenant. See `CODE_OF_CONDUCT.md` (when added).

## Questions?

- Discussions: GitHub Discussions
- Real-time: Discord/Slack (link TBD)
- Spec questions: file an issue tagged `spec`
