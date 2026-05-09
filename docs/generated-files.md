# Generated Files

Two files in the repo are generated from machine-readable specs and must never be hand-edited.
This page explains what they are, when to regenerate them, and how CI enforces correctness.

## What Is Generated

| Generated file | Source spec | Generator |
|---|---|---|
| `src/mcp/tools/_generated.ts` | `spec/mcp-tools.yaml` | `scripts/gen-schemas.ts` |
| `src/providers/types.ts` | `spec/providers.schema.json` | `scripts/gen-schemas.ts` |

### `src/mcp/tools/_generated.ts`

Contains Zod input schemas, annotation objects, type aliases, and the `TOOLSETS` registry for
every MCP tool. Consumers import from this file — they never write Zod schemas by hand.

Each tool in `spec/mcp-tools.yaml` produces:
- `clawops_<name>Schema` — `z.object(...)` matching the `input:` block
- `clawops_<name>Annotations` — title + four hint flags (R10)
- `<PascalName>Input` — TypeScript type inferred from the schema
- An entry in `TOOLSETS` so `resolveEnabledTools()` knows which toolset each tool belongs to

### `src/providers/types.ts`

Contains the `ProviderAdapter` interface, supporting types (`ConnectionInfo`, `ValidationResult`,
`InstanceAlias`, etc.), and string-literal unions derived from the provider schema enum. Every
adapter must satisfy this interface — the type checker enforces it at compile time.

## When to Regenerate

Run `pnpm gen:schemas` any time you change either source spec:

| You changed | Run |
|---|---|
| `spec/mcp-tools.yaml` (add/remove/rename tool, change input shape) | `pnpm gen:schemas` |
| `spec/providers.schema.json` (add provider, change required fields) | `pnpm gen:schemas` |

Also run it after a fresh clone if the generated files are `.gitignore`d in your fork (they are
committed in this repo, so `pnpm install` is sufficient for most contributors).

```bash
pnpm gen:schemas          # regenerate both files
pnpm gen:schemas --check  # assert committed files match spec (CI mode, exit 1 on drift)
```

## CI Enforcement

The CI workflow runs `pnpm gen:schemas --check` as a required step. If the committed generated
files don't match what the generator would produce from the current specs, CI fails with a diff.

This prevents:
- A spec edit that was never regenerated (runtime schema mismatch)
- A hand-edit to `_generated.ts` or `types.ts` that drifts from the spec

If CI fails on this step:

```bash
# Regenerate locally and commit the result
pnpm gen:schemas
git add src/mcp/tools/_generated.ts src/providers/types.ts
git commit -m "chore: regenerate from updated spec"
```

## Adding a New MCP Tool

1. Add the tool to `spec/mcp-tools.yaml` (use the existing entries as a guide; R-meta-1 requires spec-first)
2. Run `pnpm gen:schemas`
3. Import the generated schema and type in your handler and registry files
4. Do **not** write a Zod schema by hand in the handler file

See `CONTRIBUTING.md` → "Adding an MCP Tool" and the `/mcp-tool` skill for the full workflow.

## Adding a New Provider

1. Add the provider name to the `providerName` enum in `spec/providers.schema.json`
2. Run `pnpm gen:schemas` — `ProviderName` and `ProviderAdapter` update automatically
3. Scaffold `src/providers/<name>/` using `src/providers/_adapter-template.ts`
4. Your adapter must satisfy the updated `ProviderAdapter` interface (the type checker will tell you if it doesn't)

See `CONTRIBUTING.md` → "Adding a Provider" and the `/add-provider` skill for the full workflow.

## Rules That Apply

- **R-meta-1**: `spec/` is the source of truth. Generated files follow specs, not the other way.
- **R-meta-4**: CI asserts `pnpm gen:schemas --check` passes on every PR.
- Never edit `_generated.ts` or `types.ts` directly. If the generated output is wrong, fix the
  spec or the generator script — not the output.
