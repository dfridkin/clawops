# ADR 0001 — Adopt clawops Naming and Supersede the v0.1 Word Doc

**Status:** Accepted
**Date:** 2026-05-04
**Deciders:** Project author

## Context

The project's v0.1 specification was authored as a Microsoft Word document (`clawctl-spec.docx`) with the working name **clawctl**. Two issues emerged:

1. **Naming collision.** `clawctl.com` is a commercial managed-OpenClaw-hosting SaaS with no relation to this project. Continuing to use "clawctl" would create user confusion, complicate SEO, and risk trademark issues.

2. **Word doc unsuitability.** The spec format actively hurts the development workflow:
   - Cannot be read by Claude Code (binary format)
   - Cannot be diffed in PRs (changes opaque)
   - Cannot be linted, validated, or used as ground truth for codegen
   - Discourages contributions (requires Word/Pages to edit)
   - Drifts from code rapidly because there's no mechanical link

## Decision

1. **Rename the project to `clawops`.** Verified clear on npm (no existing package), GitHub, and domain availability.
2. **Replace the Word doc with a structured spec set:**
   - `PRD.md` — product requirements (narrative)
   - `SPEC.md` — technical spec (narrative)
   - `DESIGN_RULES.md` — normative R1–R25 rules
   - `CLAUDE.md` — Claude Code root context
   - `spec/*.{json,yaml}` — machine-readable schemas (ground truth)
   - `docs/architecture.md`, `docs/decisions/`, `docs/providers/` — supporting prose
3. **Forbid `.docx`, `.pages`, `.rtf` in the repo** (R-meta-2). CI enforces via `scripts/verify-no-docx.ts`.
4. **The Word doc is NOT migrated as a versioned artifact.** Its content has been carried forward into the structured set; the original is discarded.

## Consequences

**Positive:**
- Claude Code can read every spec file; full context loads on demand
- Specs can be CI-validated (R-meta-1 generated types, R-meta-4 schema-asserting tests)
- PRs surface spec changes diffably
- Schemas become first-class artifacts that drive codegen

**Negative:**
- Anyone with a copy of the v0.1 Word doc has dead reference material
- Some narrative was easier to write in Word's flowing format (mitigated by Markdown)
- Initial migration cost (one-time)

**Neutral:**
- No dependency on Word/Office/Google Docs for any contributor

## Verification

- `find . -iname "*.docx" -o -iname "*.pages" -o -iname "*.rtf"` returns empty
- `scripts/verify-no-docx.ts` runs in CI on every PR
- All five top-level spec documents exist and are Markdown
- All four schema files exist under `spec/`
