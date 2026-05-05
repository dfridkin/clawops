---
description: Rules for MCP server and tool code
globs:
  - src/mcp/**
---

# MCP rules

1. **spec/mcp-tools.yaml first (R-meta-1):** Every tool must be declared in `spec/mcp-tools.yaml` before its handler is written. The Zod schemas in `_generated.ts` are generated — do not hand-edit them.

2. **clawops_ prefix + toolset (R1):** Every tool name is `clawops_<verb>` or `clawops_<noun>_<verb>`. Assign to exactly one primary toolset.

3. **All four annotation hints required (R10):** `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` must all be explicitly set. Never rely on defaults.

4. **Stdio never writes to stdout (R15):** In stdio mode, ALL output must go to `process.stderr` or via `notifications/message`. A single stdout write outside the MCP protocol breaks the server.

5. **Tool output cap 8KB (R14):** Trim Pulumi or log output before returning. Expose full output as an MCP resource.

6. **Long-running operations (R12):** <10s = synchronous. 10–60s = emit `notifications/progress` every 2s. >60s = return `taskId` immediately.

7. **Audit log every call (R21):** `src/mcp/audit.ts` must log tool name, sanitised args, duration, result. Sanitise: `Authorization`, `*token*`, `*secret*`, `*key*` (except keyName/keyPath), `password`, `connectionString`.

8. **Elicitation for destructive tools (R19):** Tools with `destructiveHint: true` must surface a confirmation before execution unless `yes: true` is passed explicitly.

9. **Composite tools ≤3 (R2):** The `workflow` toolset contains at most 3 composite tools. Each encodes a complete user intent, not an API sequence.
