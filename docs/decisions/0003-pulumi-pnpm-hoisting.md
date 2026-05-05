# ADR 0003 — Pulumi + pnpm Hoisting Configuration

**Status:** Accepted
**Date:** 2026-05-04
**Deciders:** Project author

## Context

We use pnpm as the package manager (chosen for disk efficiency and explicit phantom-dependency rejection) and Pulumi Automation API as the embedded infrastructure engine.

pnpm's default behavior places packages in a deeply nested `node_modules/.pnpm/<name>@<version>/node_modules/<name>` structure with symlinks at the top level. The Pulumi Automation API spawns a worker process that needs to `require('@pulumi/pulumi')` from a specific resolution path. Empirically (per the schmitthub project's `AGENTS.md` and multiple community reports), pnpm's hoisting of `@pulumi/*` packages can place them at a depth where the Pulumi worker fails to resolve them, producing cryptic "engine error: cannot find @pulumi/pulumi" errors at runtime.

## Decision

1. **Add `.npmrc` at repo root with explicit Pulumi hoisting:**
   ```
   public-hoist-pattern[]=@pulumi/*
   public-hoist-pattern[]=@modelcontextprotocol/*
   ```

2. **Pin `@pulumi/pulumi` at the workspace root** (not inside individual packages if we ever add a workspace).

3. **Document the symptom** in `CLAUDE.md` quirks section so any contributor hitting the error has a fast path to the fix.

4. **Add a smoke test** in `tests/integration/pulumi-resolves.test.ts`:
   ```typescript
   import { LocalWorkspace } from '@pulumi/pulumi/automation';
   it('Pulumi Automation API resolves correctly', async () => {
     // Just creating the workspace is enough to surface resolution failures
     const ws = await LocalWorkspace.create({ projectSettings: { name: 'test', runtime: 'nodejs' } });
     expect(ws).toBeDefined();
   });
   ```

5. **Do NOT use yarn or npm as a workaround.** pnpm's correctness benefits (no phantom dependencies) outweigh the hoisting friction once configured.

## Consequences

**Positive:**
- Pulumi Automation API works reliably on every contributor's machine
- The `public-hoist-pattern` is explicit and auditable
- New contributors get a clean workspace setup via standard `pnpm install`

**Negative:**
- Loses some of pnpm's strict-isolation guarantees specifically for `@pulumi/*` packages (acceptable; Pulumi internally crosses package boundaries by design)
- `.npmrc` becomes a critical config file that must be reviewed in PRs

## Verification

- `tests/integration/pulumi-resolves.test.ts` passes on every CI run
- Fresh checkout + `pnpm install` produces a working `pnpm dev mcp serve`
- The `.npmrc` is present and the patterns are correct
