// Where log commands are built, so the CLI and the MCP tool cannot drift.
//
// Both used to run `journalctl -u openclaw 2>/dev/null || docker logs openclaw`. Only the
// local provider creates that systemd unit, so on AWS, GCP and Azure the first command always
// failed and the fallback produced the output — the right answer for the wrong reason, with
// nothing saying which one had run. The two carry different records: the journal has the
// unit's own start and stop entries, `docker logs` has only the container's stdout.
//
// OpenClaw 2.0 has its own `logs` command, which is better than either: it reads the
// gateway's structured log file and can emit JSON. It reaches the gateway over RPC, though,
// so it needs the gateway to be up — and a gateway that is down is exactly when logs matter.
// Hence a fallback, chosen deliberately and reported, rather than arrived at by accident.

/** Whether the lines came from the gateway itself or from the container around it. */
export type LogSource = 'gateway' | 'container'

export interface LogOpts {
  tail: number
  follow: boolean
  /** Only the container source can honour this: `openclaw logs` has no --since. */
  since?: string
  json?: boolean
}

/**
 * Cheap check that `openclaw logs` will work before committing to a stream.
 *
 * A stream cannot be retried once it has started emitting, which is the same reason
 * `streamPrivileged` probes for sudo first.
 */
export const GATEWAY_LOGS_PROBE =
  'docker exec openclaw openclaw logs --limit 1 >/dev/null 2>&1 && echo ok || echo no'

export function gatewayLogsCommand(opts: LogOpts): string {
  return [
    'docker exec openclaw openclaw logs',
    `--limit ${opts.tail}`,
    opts.follow ? '--follow' : '',
    opts.json ? '--json' : '',
  ]
    .filter(Boolean)
    .join(' ')
}

export function containerLogsCommand(opts: LogOpts): string {
  return [
    'docker logs openclaw',
    `-n ${opts.tail}`,
    opts.follow ? '-f' : '',
    opts.since ? `--since ${shellQuote(opts.since)}` : '',
  ]
    .filter(Boolean)
    .join(' ')
}

export interface SourceChoice {
  source: LogSource
  /** Said out loud, because the old code's whole problem was not saying. */
  reason: string
}

/**
 * Pick a log source.
 *
 * `--since` forces the container: `openclaw logs` has no equivalent flag, and silently
 * ignoring a time filter the operator asked for would show them the wrong window.
 */
export function chooseLogSource(opts: { since?: string; gatewayReachable: boolean }): SourceChoice {
  if (opts.since) {
    return {
      source: 'container',
      reason: '--since is a container-log filter; the gateway log command has no equivalent',
    }
  }
  if (!opts.gatewayReachable) {
    return {
      source: 'container',
      reason: 'the gateway is not answering, so its own logs cannot be read — showing container output',
    }
  }
  return { source: 'gateway', reason: 'read from the gateway over RPC' }
}

/**
 * Per-agent activity.
 *
 * OpenClaw 2.0 removed `agents logs`. Agent-scoped records live in the audit log instead, and
 * `openclaw logs` is gateway-wide with no agent key in its envelope — so filtering that would
 * mean substring-matching a message field and hoping.
 */
export function agentAuditCommand(opts: {
  agentId: string
  limit: number
  cursor?: string
}): string {
  return [
    'docker exec openclaw openclaw audit',
    `--agent ${shellQuote(opts.agentId)}`,
    '--kind agent_run',
    '--json',
    `--limit ${opts.limit}`,
    opts.cursor ? `--cursor ${shellQuote(opts.cursor)}` : '',
  ]
    .filter(Boolean)
    .join(' ')
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
