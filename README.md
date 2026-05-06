# clawops — Specification Set v0.2

This directory contains the complete specification for **clawops**, a TypeScript CLI for deploying and managing self-hosted OpenClaw across cloud providers.

## Document Map

| File | Purpose | Audience |
|---|---|---|
| `PRD.md` | Product requirements: who, what, why | Product, leadership, contributors orienting |
| `SPEC.md` | Technical specification: how it's built | Engineers implementing |
| `DESIGN_RULES.md` | 25 normative design pattern rules | Reference during implementation and review |
| `CLAUDE.md` | Root context file for Claude Code | Development tool |
| `spec/*.{json,yaml}` | Machine-readable schemas (ground truth) | Tooling, CI, generated code |
| `docs/architecture.md` | Narrative system overview | New engineers, deep dives |
| `docs/decisions/` | ADRs documenting key decisions | Historical reasoning |
| `docs/providers/` | Per-provider implementation guides | Engineers adding/maintaining providers |
| `.claude/skills/` | Invokable procedures for Claude Code | Development workflow |
| `.claude/rules/` | Path-scoped rule files | Loaded automatically by Claude Code |

## How These Documents Relate

```
PRD.md (what & why)
   ↓
SPEC.md (how) ← references → DESIGN_RULES.md (R1–R25 normative rules)
   ↓                              ↑
spec/*.json,*.yaml ←──────────────┘
(machine-readable; CI-validated)
   ↓
src/ (generated types + hand-written code)
```

The Word doc from v0.1 has been **superseded and should be deleted** — see ADR 0001.

## Reading Order

- **First time:** PRD → SPEC → DESIGN_RULES
- **Implementing a feature:** DESIGN_RULES → SPEC section → relevant `spec/*` schema
- **Adding a provider:** `docs/providers/_template.md` + `/add-provider` skill
- **Writing a release note:** `/changeset` skill

## Version

v0.2 — May 2026 — Renamed to "clawops" after npm/brand collision check.
