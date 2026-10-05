// One agent's activity, for `clawops agents logs` and `clawops_agents_logs`.
//
// OpenClaw 2.0 removed `agents logs`. Agent-scoped records live in the audit log now, and
// `openclaw logs` is gateway-wide with no agent key in its envelope — so filtering that would
// mean substring-matching a message field and hoping. Both surfaces read the audit log through
// here so they cannot drift in what they run or in how they report a failure. Nothing here
// prints (R15).

import { type Result, ok, err } from '../types/result.js'
import { execPrivileged } from '../transport/privileged.js'
import type { SshSession } from '../transport/ssh.js'
import { agentAuditCommand } from './logs.js'

export const DEFAULT_AGENT_LOG_LIMIT = 50

export interface AgentRun {
  at?: string
  status?: string
  kind?: string
  summary?: string
  message?: string
  [k: string]: unknown
}

export interface AgentActivityPage {
  records: AgentRun[]
  /** Present when there is more: pass it back to continue. */
  cursor?: string
}

/**
 * Run the audit query and return its raw stdout.
 *
 * Raw because `clawops agents logs --json` passes OpenClaw's own JSON through untouched.
 * `openclaw audit` is a paged query, not a stream — it returns a cursor to continue from.
 */
export async function readAgentActivityRaw(
  session: SshSession,
  opts: { agentId: string; limit?: number; cursor?: string },
  signal?: AbortSignal,
): Promise<Result<string, string>> {
  const result = await execPrivileged(
    session,
    agentAuditCommand({
      agentId: opts.agentId,
      limit: opts.limit ?? DEFAULT_AGENT_LOG_LIMIT,
      ...(opts.cursor ? { cursor: opts.cursor } : {}),
    }),
    signal,
  )
  if (result.code !== 0) {
    const why = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`
    return err(`Cannot read activity for "${opts.agentId}": ${why}`)
  }
  return ok(result.stdout)
}

/** Parse an audit page, refusing output that is not one rather than showing nothing. */
export function parseAgentActivity(agentId: string, stdout: string): Result<AgentActivityPage, string> {
  let page: { records?: AgentRun[]; cursor?: string }
  try {
    page = JSON.parse(stdout.trim() || '{}') as typeof page
  } catch {
    return err(`Cannot read activity for "${agentId}": unexpected output: ${stdout.trim().slice(0, 200)}`)
  }
  return ok({ records: page.records ?? [], ...(page.cursor ? { cursor: page.cursor } : {}) })
}

/** Both steps: query, then parse. */
export async function readAgentActivity(
  session: SshSession,
  opts: { agentId: string; limit?: number; cursor?: string },
  signal?: AbortSignal,
): Promise<Result<AgentActivityPage, string>> {
  const raw = await readAgentActivityRaw(session, opts, signal)
  if (!raw.ok) return raw
  return parseAgentActivity(opts.agentId, raw.value)
}
