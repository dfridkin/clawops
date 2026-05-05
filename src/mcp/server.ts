// MCP server — not yet implemented (M5).
// See SPEC.md §7 for design.

export interface McpServeOpts {
  port?: number
  bind?: string
  readOnly?: boolean
  noDestructive?: boolean
  toolsets?: string[]
  inspector?: boolean
}

/** Start the MCP server (stdio by default, HTTP if port is set). */
export async function serveMcp(_opts: McpServeOpts): Promise<void> {
  throw new Error('clawops mcp serve: not yet implemented (M5)')
}
