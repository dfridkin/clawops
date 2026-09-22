---
'@clawops/cli': patch
---

**`clawops mcp serve` could not start.** The published 2.0.2 binary died on import before
emitting a byte of protocol, so every MCP client that tried to connect got nothing. Half of what
this package is was unusable.

`ajv/dist/2020` resolves under CommonJS and not under ESM: ajv ships no `exports` map, so Node
looks for a file of that exact name and only `2020.js` exists. The import now carries the
extension.

This is the same bug 2.0.1 shipped as `@pulumi/pulumi/automation`, in the other half of the
product. `pnpm verify:pack` exists because of that one, and it missed this one because all four
of its checks are commands that exit and print, and the MCP server is neither. It now speaks
protocol to the packed tarball and fails if no handshake comes back. Reintroducing the bug leaves
the four original checks green and fails only the new one.
