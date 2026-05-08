# ADR 0008 — Apply-time drift detection via stack version

**Status:** Accepted  
**Date:** 2026-05-08  
**Work order:** WO-06

## Context

`clawops apply` re-runs `pulumi up` against the current live state using parameters from a reviewed
plan JSON. It does not replay a locked provider-level artifact. This means if anything touched the
stack between `clawops plan` and `clawops apply` — another engineer, a manual console change, a
parallel agent — the diff at apply time may differ from the diff the operator reviewed.

SPEC.md §15 / R2 requires a drift warning on `clawops apply` when state has changed since plan
generation.

## Decision

Capture the Pulumi **stack version** at plan generation time and compare it at apply time.

The Pulumi Automation API exposes `stack.info(): Promise<UpdateSummary | undefined>`. The returned
`UpdateSummary.version` is a monotonically incrementing integer that Pulumi increments on every
successful state write (create, update, delete, import, refresh). It is the canonical "has this
stack been touched?" signal.

At plan generation: call `stack.info()` after the preview completes and store `summary.version` in
`plan.metadata.stackVersion`. For new stacks with no history `info()` returns `undefined`; in that
case `stackVersion` is omitted from the plan.

At apply time: call `stack.info()` before `stack.up()`. If `plan.metadata.stackVersion` is present
and the current version differs, emit a stderr warning and require the operator to confirm (or pass
`--yes` to suppress).

## Alternatives considered

### Time-based threshold

Warn if `Date.now() - plan.metadata.generatedAt > N minutes`. Rejected: produces false positives
for legitimate slow pipelines (plan in CI, apply in a review-gated job an hour later) and false
negatives for near-instant changes.

### Re-run preview at apply time

Run `pulumi preview` again and compare diff counts. Accurate but adds 30–60s to every apply.
Rejected: the latency cost is borne on every apply, even when no drift occurred.

### State hash

Compute a hash of the exported resource list. More granular than version but requires downloading
the full state (`stack.exportStack()` returns `deployment: any`) and parsing an untyped blob.
Version is sufficient since any state write — including refreshes — increments it.

## Consequences

- `spec/deploy-plan.schema.json` gains an optional `metadata.stackVersion` integer field.
- Generated TypeScript types are updated via `pnpm gen:schemas`.
- `src/plan/generate.ts` calls `stack.info()` after preview and writes `stackVersion`.
- `src/plan/apply.ts` calls `stack.info()` before `stack.up()` and emits a warning if versions
  diverge. The warning is non-blocking: the operator is asked to confirm unless `--yes` is set.
- New stacks (no history → `info()` returns `undefined`) skip the check silently.
- `docs/plan-apply.md` documents the warning and how to suppress it.
