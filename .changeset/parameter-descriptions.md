---
'@clawops/cli': patch
---

**Every MCP tool parameter now documents itself.** The same failure as the tool descriptions, one
level down: 29 parameters had a description in `spec/mcp-tools.yaml` that the generator never
emitted, and 26 more had none at all. A model deciding what to pass `clawops_plan` saw
`privateOnly: boolean` with nothing saying that it closes public SSH and the gateway, needs a
verified tailnet address, and refuses unless that address answers.

All 55 parameters now carry a description into `inputSchema`, saying what the value means and
what omitting it does. The spec validator rejects a parameter without one, so the next parameter
added cannot arrive bare, and `pnpm verify:mcp` checks them over the protocol.
