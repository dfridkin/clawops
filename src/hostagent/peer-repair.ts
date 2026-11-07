// Keeping the fleet firewall table in place — ADR 0015 §4.
//
// The table is what keeps every container and user on this host from querying peers as this
// host. On a host that queries peers the host agent also refuses its own queries while the table
// is missing, but nothing refuses a connection a container opens itself: on a leaf, installed
// without --strict, the table is the only barrier. A failed load at boot, `nft flush ruleset`, or
// a firewall tool rewriting the ruleset would leave the host open until someone noticed.
//
// So the host agent, which runs as root on every fleet member, reads the table back on a timer
// and puts it back when it is missing or changed: the table install wrote, generated again from
// the uid it recorded, loaded in one transaction, and read back. Every repair, and every failure
// to repair, is logged and audited, so clawops rewriting firewall state is never silent.
//
// It loads the table from a file of its own in /tmp and leaves the rules file alone. The agent's
// unit makes /etc read-only to it (ProtectSystem=strict), and widening that would let it rewrite
// its own agent.json too. Not from stdin: nft 1.0 refuses a pipe for -f ("Not a regular file"). The file is root's, written by install; `fleet status` and doctor report a
// boot unit that would not load it.

import process from 'node:process'
import { Readable } from 'node:stream'
import type { SshSession } from '../transport/ssh.js'
import type { HostAgentConfig } from './config.js'
import { checkPeerTable, peerTable, PEER_TABLE_LIST_CMD } from './peer-firewall.js'

/** How often the table is read back. A container that finds it missing has at most this long. */
export const PEER_TABLE_CHECK_MS = 30_000

/** The interval, overridable for the e2e suite, which needs it shorter or out of the way. */
export function peerTableCheckMs(): number {
  const ms = Number(process.env['CLAWOPS_PEER_TABLE_CHECK_MS'])
  return Number.isInteger(ms) && ms >= 1_000 ? ms : PEER_TABLE_CHECK_MS
}

/** Load the table on stdin through a regular file, which is what `nft -f` reads. */
export const PEER_TABLE_LOAD_CMD = 'f=$(mktemp /tmp/clawops-peer-fw.XXXXXX) || exit 1; cat > "$f" && nft -f "$f"; r=$?; rm -f -- "$f"; exit $r'

export type RepairOutcome =
  | { kind: 'ok' }
  | { kind: 'repaired'; was: string }
  | { kind: 'failed'; was: string; failure: string }

function errText(r: { stdout: string; stderr: string; code: number }): string {
  return (r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`).slice(0, 500)
}

/** Read the table back and, when it is not the one install loaded, restore it. */
export async function repairPeerTable(session: SshSession, peerUid: number, signal?: AbortSignal): Promise<RepairOutcome> {
  const read = async () => {
    const listed = await session.exec(`${PEER_TABLE_LIST_CMD} 2>/dev/null`, signal)
    return checkPeerTable(listed.code === 0 ? listed.stdout : '', peerUid)
  }
  const before = await read()
  if (before.ok) return { kind: 'ok' }

  // The table replaces itself in one transaction: it creates, deletes and defines in one file.
  // /tmp is the unit's own (PrivateTmp), so nothing else on the host sees the file.
  const load = await session.execWithInput(PEER_TABLE_LOAD_CMD, Readable.from([Buffer.from(peerTable(peerUid))]), signal)
  if (load.code !== 0) return { kind: 'failed', was: before.reason, failure: `nft could not load it: ${errText(load)}` }
  const after = await read()
  return after.ok ? { kind: 'repaired', was: before.reason } : { kind: 'failed', was: before.reason, failure: after.reason }
}

export interface PeerTableWatchDeps {
  repair: (signal?: AbortSignal) => Promise<RepairOutcome>
  /** Called with each outcome worth recording: every repair, and a failure when its reason changes. */
  report: (outcome: Exclude<RepairOutcome, { kind: 'ok' }>) => void
}

/**
 * Check now and then every `intervalMs` until `signal` aborts. Never throws: a check that cannot
 * run is a failure to repair, reported like any other, and the timer keeps going.
 */
export async function watchPeerTable(deps: PeerTableWatchDeps, opts: { intervalMs?: number; signal?: AbortSignal } = {}): Promise<void> {
  let lastFailure = ''
  while (!opts.signal?.aborted) {
    let outcome: RepairOutcome
    try {
      outcome = await deps.repair(opts.signal)
    } catch (err) {
      outcome = { kind: 'failed', was: 'the table could not be read', failure: err instanceof Error ? err.message : String(err) }
    }
    if (outcome.kind === 'repaired') {
      lastFailure = ''
      deps.report(outcome)
    } else if (outcome.kind === 'failed') {
      const key = `${outcome.was}\n${outcome.failure}`
      if (key !== lastFailure) deps.report(outcome)
      lastFailure = key
    } else {
      lastFailure = ''
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? PEER_TABLE_CHECK_MS).unref())
  }
}

/** Start keeping this fleet member's table in place, for as long as the host agent runs. */
export function startPeerTableWatch(agent: HostAgentConfig, opts: { signal?: AbortSignal; intervalMs?: number } = {}): void {
  const peerUid = agent.fleet?.peerUid
  if (peerUid === undefined) return
  const log = (line: string) => process.stderr.write(`[clawops] ${line}\n`)
  void (async () => {
    const { localSession } = await import('../transport/local.js')
    const { auditPeerTableRepair } = await import('../mcp/audit.js')
    const session = localSession()
    await watchPeerTable({
      repair: (signal) => repairPeerTable(session, peerUid, signal),
      report: (o) => {
        if (o.kind === 'repaired') {
          log(`fleet firewall: restored the table. ${o.was}`)
          auditPeerTableRepair(o.was)
        } else {
          log(`fleet firewall: could not restore the table, so peer queries are refused. ${o.was} ${o.failure} Run \`clawops agent install\` again.`)
          auditPeerTableRepair(o.was, o.failure)
        }
      },
    }, { intervalMs: peerTableCheckMs(), ...opts })
  })()
}
