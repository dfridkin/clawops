---
'@clawops/cli': patch
---

**`clawops gateway`, `agents`, `config` and `logs` work on local-provider stacks.** Each one
looked up the stack's connection details in Pulumi, which the local provider does not use, so on
a local stack every one of them stopped with "The local provider does not use Pulumi stacks"
while its MCP tool worked. They now connect the way the tools do.
