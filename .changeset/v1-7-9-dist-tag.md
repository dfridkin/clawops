---
"@clawops/cli": patch
---

**Fixes a release-pipeline bug that left `npm install -g @clawops/cli` on the previous
version.**

v1.7.8 published under the `legacy` dist-tag, as the 1.x line is meant to. But `latest` was
*also* a 1.x version at the time, so nothing moved it: the registry served `legacy: 1.7.8`
and `latest: 1.7.7`. A fresh install kept getting 1.7.7 — the release that added
authentication to the MCP HTTP server was not the one anybody installed by default.

The `legacy`-only rule exists so a maintenance patch cannot take `latest` back from 2.x. That
is right once 2.x has shipped, and wrong before it has.

The dist-tags are now decided by `scripts/lib/dist-tag-plan.mjs`:

| Branch | Registry `latest` | Publishes under | Also moves |
|---|---|---|---|
| `1.x` | still 1.x | `legacy` | `latest` |
| `1.x` | 2.x or newer | `legacy` | — |
| `1.x` | unreadable | `legacy` | — |
| `main` | anything | changesets' default | — |

It self-disables the moment 2.0.0 ships. If a tag cannot be moved, the release job fails
rather than reporting a publish that leaves users on the old version.
