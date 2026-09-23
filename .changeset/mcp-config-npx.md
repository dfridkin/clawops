---
'@clawops/cli': patch
---

The MCP config example is `npx -y @clawops/cli mcp serve`, which works with nothing on `$PATH`
and can be copied verbatim by a directory or an installer. The absolute-path form is kept below
it for anyone who would rather point at a binary they already have. Both spell out the arguments,
because `clawops` on its own prints help and exits — it is a CLI first, and `mcp serve` is the
part that speaks the protocol.
