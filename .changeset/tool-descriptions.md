---
'@clawops/cli': patch
---

**Every MCP tool now sends its description.** The descriptions in `spec/mcp-tools.yaml` — each
written to say when to use a tool and when to reach for a different one — were generated into
nothing and passed to `registerTool` not at all, so every client since the server shipped saw 19
tools with a name, a schema and no description. A model choosing between `clawops_status` and
`clawops_doctor` had nothing to choose on. Glama scores tool descriptions and gave all 19 its
lowest mark, which is how it came to light.

The generator emits them, the registry hands them to the server, a test asserts every registered
tool has one and that it matches the spec, and `pnpm verify:mcp` checks the descriptions over the
protocol — where the only thing that counts is what `tools/list` actually returns.
