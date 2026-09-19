---
'@clawops/cli': patch
---

The MCP registry manifest (`server.json`) is bumped when the version is, rather than rewritten in
CI at publish time and never committed. The committed file had read `1.7.3` against a published
`2.0.2`.

The registry was always correct; only the file in the repository was stale. It is now updated by
`pnpm version:packages` inside the Version Packages PR, the publish step refuses to register a
manifest that disagrees with `package.json` instead of quietly rewriting it, and a test asserts
the two agree.
