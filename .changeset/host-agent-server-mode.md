---
"@clawops/cli": minor
---

`clawops mcp serve --host-agent` runs clawops on the gateway host for its own stack (ADR 0014). Tools run locally with no SSH, Pulumi state or cloud credentials; the tool set is fixed to 12 read tools plus the destructive tools the operator allowed, and each of those returns the `clawops` command for the operator to run instead of acting. Calls naming another stack, and self-targeting tools, are refused.
