// Result helpers for MCP tool handlers. resolveConn lives in src/transport/conn.ts, below
// both surfaces, and is re-exported here for the handlers that already import it from here.

export { resolveConn, type ConnInfo } from '../../transport/conn.js'

/** CallToolResult helper — error text with isError flag. */
export function errText(message: string): import('@modelcontextprotocol/sdk/types.js').CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

/** CallToolResult helper — plain text. */
export function okText(t: string): import('@modelcontextprotocol/sdk/types.js').CallToolResult {
  return { content: [{ type: 'text', text: t }] }
}
