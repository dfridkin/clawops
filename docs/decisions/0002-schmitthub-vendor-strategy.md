# ADR 0002 — schmitthub/openclaw-deploy Vendor Strategy

**Status:** Provisional (pending license verification)
**Date:** 2026-05-04
**Deciders:** Project author
**Revisit:** When `LICENSE` file in upstream repo is verified

## Context

The deep-dive research identified `schmitthub/openclaw-deploy` as the most architecturally relevant existing project to clawops. Specifically valuable:

- The Pulumi `ComponentResource` pattern with `clawops:<cat>:<Name>` URN convention
- The mock test harness using type-tagged outputs (`tests/components.test.ts`)
- The two-tier (shared infra / per-gateway) composition pattern
- The five-layer egress reference architecture

The sibling repo `schmitthub/openclaw-docker` is confirmed MIT (verified via `pkg.go.dev`). The Pulumi repo's `LICENSE` file was listed in DeepWiki's index but could not be directly fetched during research due to GitHub rate-limiting.

## Decision

Adopt a **three-track strategy** to avoid blocking on license verification:

### Track 1 — Borrow patterns immediately (no license needed)

Patterns are not copyrightable. We can adopt:
- The URN naming convention (`clawops:<cat>:<Name>`)
- The component constructor structure (Args interface, super() call, registerOutputs)
- The two-tier composition idea
- The conceptual five-layer egress model

These are reimplemented from scratch in clawops based on the *idea*, not the code.

### Track 2 — Defer code vendoring until license confirmed

Until we directly verify `LICENSE` is MIT or Apache-2.0:
- Do NOT copy code verbatim from the schmitthub repo
- Do NOT include their tests, templates, or config files

If verified MIT/Apache:
- Vendor `tests/components.test.ts` mock harness with attribution in `NOTICE`
- Vendor any small utility files we have specific need for, with attribution

### Track 3 — Build interop, not a fork

Whether or not we vendor code, we will NOT fork the project. Instead:
- Document `schmitthub/openclaw-deploy` as a peer alternative for users who want its specific egress topology
- Optionally: clawops can generate Pulumi programs that *use* the schmitthub library if it's published to npm
- This makes clawops complementary to schmitthub's work, not competitive

## Consequences

**Positive:**
- We can proceed with M0 without waiting on license verification
- Pattern adoption (Track 1) is immediate and unblocked
- If license turns out restrictive, no clean-room work to undo
- If license turns out permissive, we can opportunistically pull in specific files later

**Negative:**
- We rebuild some scaffolding that already exists upstream
- Slight risk that "borrowed pattern" boundaries get fuzzy if we copy too closely

**Mitigation:**
- Code reviewers verify that any pattern-borrowed code reads as fresh authorship
- An issue is opened in the upstream repo asking for explicit MIT confirmation
- If the upstream maintainer is responsive and licenses MIT, we revisit this ADR

## Action Items

- [ ] Open issue at `https://github.com/schmitthub/openclaw-deploy` asking for explicit MIT/Apache-2.0 license clarification
- [ ] Reach out to maintainer via GitHub if no response in 30 days
- [ ] If MIT/Apache-2.0 confirmed: revisit and approve specific file vendoring in a new ADR
- [ ] If proprietary or no response: leave Track 1 as the permanent path

## Verification

- `git log --grep="schmitthub"` should show no copy-paste commits without attribution
- `NOTICE` file documents any attribution
- `docs/architecture.md` § egress credits the pattern to schmitthub
