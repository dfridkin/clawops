# /release

Cut a clawops release.

## Pre-flight checklist

1. All tests pass: `pnpm test`
2. No typecheck errors: `pnpm typecheck`
3. Lint clean: `pnpm lint`
4. Generated files current: `pnpm gen:schemas --check`
5. All commits follow conventional format (`feat`, `fix`, `docs`, `refactor`, `chore`, `test`, `perf`, `ci`)
6. A changeset exists for every user-visible change: `ls .changeset/*.md`

## Steps

1. **Create changeset** (if not already done): `pnpm changeset`

2. **Open the Version Packages PR:**
   Push to `main` — the `release.yml` workflow will automatically create or update
   a "Version Packages" PR that bumps `package.json` and `CHANGELOG.md`.

3. **Review and merge** the Version Packages PR.

4. **Workflow publishes** to npm with provenance automatically on merge.

## Manual publish (emergency only)

```bash
pnpm build
pnpm changeset version
pnpm release    # calls: changeset publish --provenance
```

## Notes

- Publishing requires `NPM_TOKEN` in GitHub Secrets.
- Provenance is enabled via `id-token: write` permission in `release.yml`.
- Never force-push `main` after a release tag is created.
