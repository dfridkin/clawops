/**
 * Moving clawops onto a stack's tailnet address, safely (WO-34, steps 4 and 5).
 *
 * The spec ran these as "rewrite config, then verify". They run the other way round here: the
 * address is verified first and the override is only written if verification succeeds, so a
 * stack is never pointed at an address nothing has reached.
 *
 * Verification has to prove two things, not one. Reachability — that this machine can get to the
 * address at all, which it cannot unless it is on the same tailnet — and identity: that what
 * answers on 100.x is the host clawops already trusts, not whatever happens to be there. clawops
 * trusts unknown hosts on first use, so connecting to the new address cold would prove the first
 * and assume the second. Instead the host's keys are read over the existing public connection,
 * which is already verified, and pinned for the tailnet address before the new connection opens.
 */

import { readFileSync, appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import type { RemoteExec } from './types.js'
import type { ConnectionInfo } from '../providers/types.js'
import { formatKnownHostsLine, keyTypeFromBlob, verifyAgainstKnownHosts } from '../transport/known-hosts.js'
import { parseStatus, isTailscaleIpv4 } from './modules/tailscale.js'

export interface HostKey {
  type: string
  blob: Buffer
}

/**
 * The host's public keys, from the `.pub` files sshd serves.
 *
 * Every type, not just one. When a known_hosts file has any entry for a host, a presented key
 * that matches none of them is a mismatch rather than an unknown, so pinning only ed25519 and
 * then having ssh2 negotiate ecdsa would refuse the connection. Each line is checked against the
 * type its own blob declares, so a malformed or mislabelled file cannot pin the wrong thing.
 */
export function parseHostKeys(text: string): HostKey[] {
  const out: HostKey[] = []
  for (const line of text.split('\n')) {
    const [declared, b64] = line.trim().split(/\s+/)
    if (!declared || !b64) continue
    let blob: Buffer
    try {
      blob = Buffer.from(b64, 'base64')
    } catch {
      continue
    }
    const actual = keyTypeFromBlob(blob)
    if (!actual || actual !== declared) continue
    out.push({ type: actual, blob })
  }
  return out
}

/** Pin the keys for the tailnet address, skipping any already on file so re-runs stay tidy. */
export function pinKeys(knownHostsPath: string, host: string, port: number, keys: HostKey[]): number {
  let content = ''
  try {
    content = readFileSync(knownHostsPath, 'utf-8')
  } catch {
    // No file yet is fine: nothing is pinned, which is what we are about to change.
  }
  let added = 0
  mkdirSync(path.dirname(knownHostsPath), { recursive: true })
  for (const k of keys) {
    if (verifyAgainstKnownHosts(content, host, port, k.blob) === 'match') continue
    const line = formatKnownHostsLine(host, port, k.type, k.blob)
    appendFileSync(knownHostsPath, line, 'utf-8')
    content += line
    added += 1
  }
  return added
}

export type CutoverResult =
  | { ok: true; ip: string; hostname?: string; pinned: number }
  | { ok: false; reason: string }

export interface CutoverDeps {
  /** A command runner over the existing, already-verified public connection. */
  exec: RemoteExec
  /** Open a fresh session to the given connection and run a no-op; resolves true on success. */
  probe: (conn: ConnectionInfo) => Promise<boolean>
}

/**
 * Verify the tailnet address end to end. Writes known_hosts entries for it, and nothing else:
 * persisting the override is the caller's job, and only on `ok`.
 */
export async function verifyTailnetAddress(
  publicConn: ConnectionInfo,
  deps: CutoverDeps,
): Promise<CutoverResult> {
  const status = parseStatus((await deps.exec('tailscale status --json 2>/dev/null || true')).stdout)
  if (status.state !== 'Running' || !status.ipv4 || !isTailscaleIpv4(status.ipv4)) {
    return {
      ok: false,
      reason:
        'The host is not on a tailnet yet, so there is no address to move to. Run ' +
        '`clawops harden --options tailscale` first.',
    }
  }
  const ip = status.ipv4

  const keys = parseHostKeys((await deps.exec('cat /etc/ssh/ssh_host_*_key.pub 2>/dev/null')).stdout)
  if (keys.length === 0) {
    return {
      ok: false,
      reason:
        'Could not read the host keys over the public connection, so the tailnet address cannot ' +
        'be tied to this host. Nothing was changed.',
    }
  }
  const pinned = pinKeys(publicConn.knownHostsPath, ip, publicConn.port, keys)

  const reached = await deps.probe({ ...publicConn, host: ip })
  if (!reached) {
    return {
      ok: false,
      reason:
        `The host is on the tailnet as ${ip}, but this machine could not reach it there. ` +
        'The usual cause is that this machine is not on the same tailnet: install Tailscale here ' +
        'and sign in to the same account. clawops still uses the public address; nothing else ' +
        'was changed.',
    }
  }
  return { ok: true, ip, ...(status.hostname ? { hostname: status.hostname } : {}), pinned }
}
