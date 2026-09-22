---
'@clawops/cli': patch
---

The MCP registry manifest (`server.json`) is bumped when the version is, rather than rewritten in
CI at publish time and never committed. The committed file had read `1.7.3` against a published
`2.0.2`.

The registry entry itself was further behind still: it has served `1.2.1` since that release,
because the step that registers it had been failing for several releases without failing the
run. Every MCP client that discovered clawops through the registry was offered a version from
long before 2.0. This is the first release that updates it.

`server.json` is now bumped by `pnpm version:packages` inside the Version Packages PR, the
publish step refuses to register a manifest that disagrees with `package.json` instead of
quietly rewriting it, and a test asserts the two agree.
