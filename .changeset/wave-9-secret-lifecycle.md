---
"@clawops/cli": minor
---

feat(secret): secret lifecycle CLI — list, set, delete, rotate, audit (WO-25)

- `clawops secret list` — show all secrets in ~/.clawops/secrets/ with status and last-modified
- `clawops secret set <name>` — create or update a secret interactively (hidden input, chmod 600)
- `clawops secret delete <name>` — remove a secret with cross-stack ref warning
- `clawops secret rotate <name>` — update secret + re-apply config overlay + gateway restart
- `clawops secret audit` — report empty/missing secret files and unresolvable $secret: refs
- `src/plan/overlay-store.ts` — persist config overlay + secrets refs per stack so rotate can re-apply without re-running the wizard
- `clawops setup` and `clawops apply` now save the overlay after each successful apply
- `docs/secrets.md` — full secret lifecycle reference: sources, rotation procedures, security notes
