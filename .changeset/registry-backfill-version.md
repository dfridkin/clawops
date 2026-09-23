---
'@clawops/cli': patch
---

The MCP registry backfill registers the version that was released rather than the one being
prepared. Changesets runs `version` in the working tree before pushing the release PR, so a
manual backfill read a `package.json` bumped to the next version, waited five minutes for npm to
serve a version it had never published, and failed — leaving the entry it was dispatched to
repair exactly where it was.
