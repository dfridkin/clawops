// MCP audit logger — not yet implemented (M5).
// Per R21: writes structured JSON to stderr; sanitises sensitive keys.

export interface AuditEntry {
  ts: string
  sessionId: string
  tool: string
  args: Record<string, unknown>
  durationMs: number
  result: 'ok' | 'error'
  resourceCount?: number
}

/** Write an audit entry to stderr. No-op until M5. */
export function auditLog(_entry: AuditEntry): void {
  // TODO M5: implement
}
