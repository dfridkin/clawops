---
'@clawops/cli': patch
---

**A stack whose state cannot be read says why.** When clawops could not open a stack's state
backend, every tool and command that connects to the stack reported Pulumi's `code: -2` and
nothing else. It now names the stack and Pulumi's actual error, and says where credentials are
usually missing: an MCP server gets only the environment its client config gives it, not the
shell's, so an `AWS_PROFILE` exported in a terminal does not reach it.
