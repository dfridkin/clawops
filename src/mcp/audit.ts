// MCP audit logger — per R21.
// Writes structured JSON to stderr (R15-safe) AND appends to disk log.

import { appendFileSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import process from 'node:process'
import { getConfigDir, getConfig } from '../config/store.js'

export interface AuditEntry {
  ts: string
  sessionId: string
  tool: string
  args: Record<string, unknown>
  durationMs: number
  result: 'ok' | 'error'
  resourceCount?: number
}

// One session ID per server process
let _sessionId: string | null = null
export function getSessionId(): string {
  if (!_sessionId) _sessionId = randomUUID()
  return _sessionId
}

/** Keys whose VALUES must be redacted (case-insensitive substring match). */
const SENSITIVE_KEYS = ['token', 'secret', 'password', 'connectionstring', 'authorization']
/** Keys exempt from redaction even if they match a pattern. */
const EXEMPT_KEYS = ['keyname', 'keypath', 'privateKeyPath', 'knownHostsPath']

const ARN_RE = /arn:aws:[a-z0-9\-*]+:[a-z0-9\-]*:[0-9]*:[^\s,'"]+/gi

export function sanitize(args: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args)) {
    const kl = k.toLowerCase()
    const exempt = EXEMPT_KEYS.some((e) => kl === e.toLowerCase())
    const sensitive = !exempt && SENSITIVE_KEYS.some((s) => kl.includes(s))
    if (sensitive) {
      result[k] = '[REDACTED]'
    } else if (typeof v === 'string') {
      result[k] = v.replace(ARN_RE, 'arn:aws:***:<region>:<account>:***')
    } else if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      result[k] = sanitize(v as Record<string, unknown>)
    } else {
      result[k] = v
    }
  }
  return result
}

/** Write an audit entry to stderr and append to the audit log file. */
export function auditLog(entry: AuditEntry): void {
  const line = JSON.stringify(entry) + '\n'
  process.stderr.write(line)
  try {
    const logPath = getAuditLogPath()
    mkdirSync(path.dirname(logPath), { recursive: true })
    appendFileSync(logPath, line, { encoding: 'utf-8' })
  } catch {
    // Never crash the server due to audit log I/O failure
  }
}

function getAuditLogPath(): string {
  const cfg = getConfig()
  return cfg?.mcp?.auditLogPath ?? path.join(getConfigDir(), 'mcp-audit.log')
}

/**
 * Wrap a tool handler with audit logging and timing.
 * The wrapper calls auditLog on both success and error.
 */
export function withAudit<T>(
  toolName: string,
  handler: (input: T) => Promise<import('@modelcontextprotocol/sdk/dist/esm/types.js').CallToolResult>,
): (input: T) => Promise<import('@modelcontextprotocol/sdk/dist/esm/types.js').CallToolResult> {
  return async (input: T) => {
    const start = Date.now()
    try {
      const result = await handler(input)
      auditLog({
        ts: new Date().toISOString(),
        sessionId: getSessionId(),
        tool: toolName,
        args: sanitize(input as Record<string, unknown>),
        durationMs: Date.now() - start,
        result: 'ok',
      })
      return result
    } catch (err) {
      auditLog({
        ts: new Date().toISOString(),
        sessionId: getSessionId(),
        tool: toolName,
        args: sanitize(input as Record<string, unknown>),
        durationMs: Date.now() - start,
        result: 'error',
      })
      throw err
    }
  }
}
