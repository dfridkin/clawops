# clawops.fyi

Landing page and developer docs, deployed to Vercel from this directory.

It lives in the main repo on purpose: `CLAUDE.md`'s living-documentation rule requires a docs change
to ride with the code change that caused it. A separate repo would make that impossible.

## Layout

| Path | What |
|---|---|
| `app/page.tsx` | Landing page — hand-written, CSS modules, no framework styling |
| `app/docs/` | Docs route, powered by Fumadocs |
| `content/docs/` | Docs content as MDX |
| `app/docs/docs.css` | Tailwind + Fumadocs styles, **scoped to `/docs`** |

Tailwind is imported only from the docs layout, so its preflight never reaches the landing page.
Next scopes a layout's CSS to that route subtree; the two share only `globals.css`.

## Local

```bash
pnpm install
pnpm dev          # http://localhost:3000
pnpm build
```

`pnpm dev` and `pnpm build` run `fumadocs-mdx` first to generate `.source/` from `content/docs/`.

## Vercel

Set the project's **root directory** to `site/`. The site is independent of the CLI package — its
own `package.json` and lockfile, and excluded from the root `tsconfig`, `eslint` and `vitest`
globs, so it does not affect CLI CI.

## Docs content

`content/docs/` is the **user-facing** surface: installing, deploying, operating. The repository's
`docs/` directory holds contributor and design material — ADRs, the roadmap, spike results,
architecture — and is deliberately not published here.

This is a curated initial set rather than a bulk import. Several pages under `docs/` are known to be
stale pending the WO-49 documentation audit, and publishing those to a canonical URL would be worse
than leaving them in the repo. Pages are added here as they are verified.
