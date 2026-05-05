# /mcp-tool

Add a new MCP tool.

## Steps

1. **Add the tool to `spec/mcp-tools.yaml`** (source of truth, R-meta-1):
   - Name: `clawops_<verb>` or `clawops_<noun>_<verb>`
   - Assign `toolset` (cli | workflow | read | admin — or array)
   - Write `description` with "Use when" and "Do NOT use when" (R3)
   - Set ALL four `annotations` hints (R10): `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`
   - Define `input` fields with types and optional/default

2. **Regenerate `_generated.ts`:**
   ```
   pnpm gen:schemas
   ```

3. **Create the handler** in the appropriate toolset subdirectory:
   ```
   src/mcp/tools/<toolset>/<tool-name>.ts
   ```

4. **Register the handler** in `src/mcp/server.ts`.

5. **Write tests** in `tests/mcp/tools.test.ts` — invoke via in-memory MCP client and assert schema conformance.

6. **Run `pnpm typecheck && pnpm test`.**

## Constraints

- Per `.claude/rules/mcp.md`: no credentials in inputs (R6), stdio never writes stdout (R15), cap output at 8KB (R14).
- Destructive tools must trigger elicitation (R19) unless `yes: true`.
- Long-running tools (>10s) must emit `notifications/progress` or return a `taskId`.
