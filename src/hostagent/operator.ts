// The operator's side of a handoff — ADR 0014 §3.
//
// The host agent records each request in handoffs.jsonl on its host. The operator's clawops
// reads that file over SSH for `status` and `clawops_status`, and appends a `cleared` line
// after it carries out a matching command. Nothing here runs in host-agent mode: the host
// agent reads its own file directly.

import path from 'node:path'
import type { ClawopsContext } from '../cli/context.js'
import type { SshSession } from '../transport/ssh.js'
import type { ConnInfo } from '../transport/conn.js'
import { shellQuote, sudoWrap } from '../transport/privileged.js'
import { HOST_AGENT_STATE_DIR } from './config.js'
import { clearedLine, handoffCommand, parseHandoffs, SECRET_PLACEHOLDER, type Handoff } from './handoff.js'
import { hostAgent } from './mode.js'

export const HOST_HANDOFFS_PATH = path.posix.join(HOST_AGENT_STATE_DIR, 'handoffs.jsonl')

/** How long `status` waits on the host before giving up on its requests. */
export const HANDOFF_CHECK_TIMEOUT_MS = 10_000

/**
 * A shell line that runs `privileged` only on a host with a host agent.
 *
 * The state directory is 0700 root, so the file inside it can only be seen with sudo. The
 * directory itself can be seen without, which keeps a host with no host agent from needing
 * sudo at all — and from a failure there turning into a note on every `status`.
 */
function onAgentHost(privileged: string): string {
  return `[ -e ${HOST_AGENT_STATE_DIR} ] || exit 0; ${sudoWrap(`test -f ${HOST_HANDOFFS_PATH} || exit 0; ${privileged}`)}`
}

/** What `status` says when the host could not be asked. Shared so both surfaces say it alike. */
export const CHECK_FAILED = 'Could not check the host for requests from its agent'

export type HandoffsRead = { ok: true; value: Handoff[] } | { ok: false; error: string }

export async function readHostHandoffs(session: SshSession, signal?: AbortSignal): Promise<HandoffsRead> {
  const r = await session.exec(onAgentHost(`cat ${HOST_HANDOFFS_PATH}`), signal)
  if (r.code !== 0) return { ok: false, error: r.stderr.trim() || `exit ${r.code}` }
  return { ok: true, value: parseHandoffs(r.stdout) }
}

/**
 * Pending requests on the stack's host, for `status`. Opens its own session so a status
 * that reads no SSH otherwise still sees them, and is bounded so a host that does not answer
 * costs a note, not a hang.
 */
export async function pendingOnHost(ctx: ClawopsContext, timeoutMs = HANDOFF_CHECK_TIMEOUT_MS): Promise<HandoffsRead> {
  const { resolveConn } = await import('../transport/conn.js')
  const { acquireSession, drainPool } = await import('../transport/pool.js')
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    const conn = await resolveConn(ctx)
    const { session, release } = await acquireSession({ ...conn, signal })
    try {
      return await readHostHandoffs(session, signal)
    } finally {
      release()
      drainPool()
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Record that the operator carried out `tool` with `input` on `stack`, clearing every pending
 * request for the same command. Called after the command succeeds. Never fails the command:
 * a request left showing lapses after 7 days.
 */
export async function clearHostHandoffs(
  session: SshSession,
  tool: string,
  input: Record<string, unknown>,
  stack: string,
  signal?: AbortSignal,
): Promise<void> {
  if (hostAgent()) return
  try {
    const line = clearedLine(handoffCommand(tool, input, stack))
    await session.exec(onAgentHost(`printf '%s\\n' ${shellQuote(line)} >> ${HOST_HANDOFFS_PATH}`), signal)
  } catch {
    // Best effort, as above.
  }
}

/** As above, for a caller that holds a connection rather than a session (`harden`). */
export async function clearOnConn(
  conn: ConnInfo,
  tool: string,
  input: Record<string, unknown>,
  stack: string,
): Promise<void> {
  if (hostAgent()) return
  try {
    const { acquireSession, drainPool } = await import('../transport/pool.js')
    const signal = AbortSignal.timeout(HANDOFF_CHECK_TIMEOUT_MS)
    const { session, release } = await acquireSession({ ...conn, signal })
    try {
      await clearHostHandoffs(session, tool, input, stack, signal)
    } finally {
      release()
      drainPool()
    }
  } catch {
    // Best effort, as above.
  }
}

/** The banner `status` prints: the commands, each on its own line, ready to copy. */
export function handoffBanner(stack: string, handoffs: readonly Handoff[]): string {
  const n = handoffs.length
  const lines = [`${stack} has ${n} request${n === 1 ? '' : 's'} from its agent:`]
  for (const h of handoffs) lines.push(`    ${h.command}`)
  if (handoffs.some((h) => h.needsValue)) {
    lines.push(`Replace ${SECRET_PLACEHOLDER} with the value before running.`)
  }
  lines.push('Each one clears when you run it, or after 7 days.')
  return lines.join('\n')
}

/** What `status --json` and `clawops_status` report for each request. */
export function handoffSummary(h: Handoff): { at: string; command: string } {
  return { at: h.at, command: h.command }
}
