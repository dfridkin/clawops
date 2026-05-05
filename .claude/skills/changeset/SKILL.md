# /changeset

Record a release note using Changesets.

## Steps

1. Run:
   ```
   pnpm changeset
   ```

2. Follow the interactive prompts:
   - Select bump type: `patch` (bug fix) | `minor` (new feature) | `major` (breaking change)
   - Write a concise changelog entry describing the user-visible change

3. Commit the generated `.changeset/<random-name>.md` file along with your code changes.

## Conventional commits reminder

Commit messages must follow the convention: `feat`, `fix`, `docs`, `refactor`, `chore`, `test`, `perf`, `ci`.

The `/release` skill enforces this before publishing.

## When to cut a changeset

- Every user-visible change needs a changeset.
- Internal refactors (`chore`, `refactor`) can skip changesets.
- When in doubt, add one — it can always be removed during the version PR review.
