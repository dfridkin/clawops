# /plan

Structured planning and review workflow. Use before making significant code changes.

---

## Engineering preferences (apply throughout)

- **DRY** — flag repetition aggressively.
- **Well-tested** — more tests rather than fewer; non-negotiable.
- **Engineered enough** — not fragile/hacky, not prematurely abstracted.
- **Edge cases** — thoughtfulness over speed; handle more, not fewer.
- **Explicit over clever** — always.

---

## Before starting

Ask the user which mode they want:

**1 / BIG CHANGE** — Work through all four sections interactively (Architecture → Code Quality → Tests → Performance), with at most 4 top issues per section. Pause for feedback after each section before moving on.

**2 / SMALL CHANGE** — Work through interactively with ONE question per section.

---

## Review sections

### 1. Architecture review

Evaluate:
- Overall system design and component boundaries.
- Dependency graph and coupling concerns.
- Data flow patterns and potential bottlenecks.
- Scaling characteristics and single points of failure.
- Security architecture (auth, data access, API boundaries).

### 2. Code quality review

Evaluate:
- Code organisation and module structure.
- DRY violations — be aggressive.
- Error handling patterns and missing edge cases (call these out explicitly).
- Technical debt hotspots.
- Areas that are over-engineered or under-engineered.

### 3. Test review

Evaluate:
- Test coverage gaps (unit, integration, e2e).
- Test quality and assertion strength.
- Missing edge case coverage.
- Untested failure modes and error paths.

### 4. Performance review

Evaluate:
- N+1 queries and data access patterns.
- Memory-usage concerns.
- Caching opportunities.
- Slow or high-complexity code paths.

---

## Format for every issue found

For each specific issue (bug, smell, design concern, or risk):

1. **Describe the problem** concretely, with file and line references.
2. **Present 2–3 options**, including "do nothing" where reasonable.
3. For each option specify: implementation effort, risk, impact on other code, maintenance burden.
4. **Give an opinionated recommendation** mapped to the engineering preferences above. Always list the recommended option first.
5. **Use `AskUserQuestion`** — number each issue and letter each option (e.g. Issue 3, Option A) so the user can respond unambiguously.

> Do not assume priorities on timeline or scale. After each section, pause and wait for feedback before proceeding.
