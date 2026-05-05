# src/mcp — MCP server

## Key rules

- R1: `clawops_` prefix. All tools in `spec/mcp-tools.yaml` first.
- R10: Every tool sets all four annotation hints + title.
- R14: Cap tool output at 8KB; full output as `clawops://stacks/{name}/last-run` resource.
- R15: Stdio MCP servers never write to stdout. Use `process.stderr.write` or `notifications/message`.
- R21: Audit log every tool call with args (sanitised) and result.

## Adding a tool

Use the `/mcp-tool` skill. It:
1. Adds the tool to `spec/mcp-tools.yaml`
2. Runs `pnpm gen:schemas` to regenerate `_generated.ts`
3. Creates the handler in `src/mcp/tools/<toolset>/<name>.ts`
4. Wires it into `src/mcp/server.ts`

## Sanitisation (R21)

Strip from audit logs: `Authorization`, `*token*`, `*secret*`, `*key*` (except keyName/keyPath), `password`, `connectionString`.
