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

/**
 * Keys whose VALUES must be redacted (case-insensitive substring match). Every pattern in
 * `spec/errors.yaml → redaction.patterns` must be covered by one of these; a test enforces it.
 * `credential` was missing, so GOOGLE_APPLICATION_CREDENTIALS reached the log in the clear.
 */
export const SENSITIVE_KEYS = ['token', 'secret', 'key', 'password', 'connectionstring', 'authorization', 'credential']
/** Keys exempt from redaction even if they match a pattern. */
const EXEMPT_KEYS = ['keyname', 'keypath', 'privateKeyPath', 'knownHostsPath']

const ARN_RE = /arn:aws:[a-z0-9\-*]+:[a-z0-9\-]*:[0-9]*:[^\s,'"]+/gi

function isSensitiveName(name: string): boolean {
  const n = name.toLowerCase()
  const exempt = EXEMPT_KEYS.some((e) => n === e.toLowerCase())
  return !exempt && SENSITIVE_KEYS.some((s) => n.includes(s))
}

/** True when a dotted config path names a secret anywhere along it, e.g. `models.providers.openai.apiKey`. */
export function isSecretPath(dotPath: string): boolean {
  return dotPath.split('.').some(isSensitiveName)
}

/**
 * A config value as it may be shown or logged. Hidden whole when its path names a secret; a JSON
 * object (`config set channels.telegram '{"botToken":"..."}'`) is sanitized field by field.
 */
export function redactConfigValue(dotPath: string, value: string): string {
  if (isSecretPath(dotPath)) return '[REDACTED]'
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { return value }
  if (parsed === null || typeof parsed !== 'object') return value
  return JSON.stringify(sanitizeValue(parsed))
}

function sanitizeValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sanitizeValue)
  if (v !== null && typeof v === 'object') return sanitize(v as Record<string, unknown>)
  return v
}

export function sanitize(args: Record<string, unknown>): Record<string, unknown> {
  // The config tools take `key` as a dotted *path*, and the secret is in `value`. Matched by
  // name, `key` hit the `key` pattern and was redacted while `value` was logged in clear, so
  // `config_set models.providers.openai.apiKey sk-...` wrote the API key to the audit log.
  if (typeof args['key'] === 'string') {
    const { key, value, ...rest } = args
    const out: Record<string, unknown> = { ...sanitize(rest), key }
    if (value !== undefined) {
      out['value'] = typeof value === 'string' ? redactConfigValue(key as string, value) : '[REDACTED]'
    }
    return out
  }
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
    } else if (Array.isArray(v)) {
      result[k] = v.map((item) =>
        item !== null && typeof item === 'object' && !Array.isArray(item)
          ? sanitize(item as Record<string, unknown>)
          : item,
      )
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
  handler: (input: T) => Promise<import('@modelcontextprotocol/sdk/types.js').CallToolResult>,
): (input: T) => Promise<import('@modelcontextprotocol/sdk/types.js').CallToolResult> {
  return async (input: T) => {
    const start = Date.now()
    try {
      const result = await handler(input)
      /*
       * A tool that failed reports it by returning `isError`, not by throwing — errText is how
       * nearly every handler here refuses, and only a handful ever throw. Reading only the throw
       * path, this log recorded `ok` for every refusal and every failure in the product: a
       * destroy that was declined and a destroy that ran looked identical in the audit trail.
       */
      auditLog({
        ts: new Date().toISOString(),
        sessionId: getSessionId(),
        tool: toolName,
        args: sanitize(input as Record<string, unknown>),
        durationMs: Date.now() - start,
        result: result.isError === true ? 'error' : 'ok',
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
