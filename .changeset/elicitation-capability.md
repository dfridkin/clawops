---
'@clawops/cli': patch
---

**A client that cannot show a confirmation now gets an answer it can act on.** Every destructive
tool asks for confirmation (R19) by calling MCP elicitation, and elicitation is a capability a
client declares at connect. Against a client without it — Glama's inspector, among others — the
SDK threw `Client does not support form elicitation`, which names no tool, no stack, and no way
forward. All eight call sites now check first and return: *ask the user, then call again with
`yes: true`*.

Nothing changed about the rule. Unconfirmed destructive work still does not run; being unable to
ask is simply no longer reported as a crash.

**The "no config" error stops pointing at a tool that does not exist.** `clawops init` is a
terminal command with no MCP tool, so an agent reading "Run `clawops init` first" was told to do
the one thing it cannot. The message now names the config file, says `init` is CLI-only, and says
what it asks for — which is what every tool returns on a machine that has never run clawops.
