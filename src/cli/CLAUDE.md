# src/cli — CLI entry layer

citty-based command handlers. One file per verb in `commands/`.

## Conventions

- Every command uses `defineCommand` from citty.
- All output goes through `src/output/human.ts` (human) or `src/output/json.ts` (--json).
  Never `console.log` directly from a command handler.
- Throw at this boundary only. Library functions return `Result<T, E>`.
- Command stubs throw `Error('not yet implemented (M<n>)')` until the milestone arrives.

## Adding a command

1. Create `src/cli/commands/<verb>.ts` with `defineCommand` default export.
2. Import and register in `src/cli/index.ts` `subCommands`.
3. Add matching MCP tool in `spec/mcp-tools.yaml`.
