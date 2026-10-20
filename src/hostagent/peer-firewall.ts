// The fleet's firewall table — ADR 0015 §4, measured in SP-16.
//
// Tailnet identity names a host, not a process on it. A connection that any container or user on
// this host opens to a peer's agent port leaves over the host's tailnet address, so the peer
// identifies it as this host, tag and all. Two rules keep everything but the host agent's own
// peer client off that port:
//
//   - `pre` drops traffic from the Docker bridges to the tailnet prefixes on the peer port. That
//     covers the gateway, on the default bridge, and containers on user-defined bridges.
//   - `out` resets the peer port on `tailscale0` for every uid but the peer client's. That
//     covers other host processes and `--network host` containers.
//
// They are one nftables table of clawops's own rather than iptables rules. Once tailscaled runs
// in nftables mode it writes native rules into iptables-nft's `mangle PREROUTING`, and iptables
// can no longer list or change that chain (SP-16 finding 8). In a table of its own a `drop` is
// final whatever another table accepts, and Docker, tailscaled and ufw leave it alone.
//
// Every host in a fleet gets it, not only hosts that query peers: a leaf's containers could
// otherwise query the leaf's peers as the leaf.
//
// Nothing persists a table across a reboot, so a oneshot unit loads it, ordered before Docker:
// Docker starts the containers it restarts as soon as it is up. The rules match interfaces by
// name, so the bridges and tailscale0 need not exist yet.

import path from 'node:path'
import { HOST_AGENT_CONFIG_PATH } from './config.js'

/** The port a host agent serves peers on. Fixed, so every host's rules can name it. */
export const PEER_PORT = 18800

export const PEER_TABLE = 'clawops_peer'
export const PEER_FW_UNIT = 'clawops-peer-fw.service'
export const PEER_FW_UNIT_PATH = `/etc/systemd/system/${PEER_FW_UNIT}`
export const PEER_FW_RULES_PATH = `${path.posix.dirname(HOST_AGENT_CONFIG_PATH)}/peer-fw.nft`

/**
 * The system user peer queries run as. The host agent itself runs as root, and so does every
 * `--network host` container, so the owner rule cannot name root.
 */
export const PEER_USER = 'clawops-peer'

/** Tailscale's address ranges. Headscale can be configured with others; these are its defaults. */
export const TAILNET_V4 = '100.64.0.0/10'
export const TAILNET_V6 = 'fd7a:115c:a1e0::/48'

/** Docker's default bridge and its user-defined ones. */
const BRIDGES = ['docker0', 'br-*'] as const

/**
 * One rule per interface pattern, not a set: nft 1.0.2 (Ubuntu 22.04) rejects a wildcard inside
 * a set, `iifname { "docker0", "br-*" }`, and loads nothing (SP-16 finding 12).
 */
function preRules(): string[] {
  const rules: string[] = []
  for (const [family, prefix] of [['ip', TAILNET_V4], ['ip6', TAILNET_V6]] as const) {
    for (const bridge of BRIDGES) {
      rules.push(`iifname "${bridge}" ${family} daddr ${prefix} tcp dport ${PEER_PORT} counter drop`)
    }
  }
  return rules
}

function outRules(uid: number): string[] {
  return [`oifname "tailscale0" tcp dport ${PEER_PORT} meta skuid != ${uid} counter reject with tcp reset`]
}

const PRE_HEAD = 'type filter hook prerouting priority mangle; policy accept;'
const OUT_HEAD = 'type filter hook output priority filter; policy accept;'

/**
 * The rules file, for `nft -f`. It replaces the table in one transaction: the first line creates
 * it if absent, so the delete always succeeds, and nothing is ever left half-loaded.
 */
export function peerTable(uid: number): string {
  if (!Number.isInteger(uid) || uid <= 0) throw new Error(`The peer client's uid must be a non-root uid, not ${uid}.`)
  const chain = (name: string, head: string, rules: string[]) =>
    [`  chain ${name} {`, `    ${head}`, ...rules.map((r) => `    ${r}`), '  }']
  return [
    `# Written by \`clawops agent install\` (ADR 0015). Remove with \`clawops agent uninstall\`.`,
    `table inet ${PEER_TABLE}`,
    `delete table inet ${PEER_TABLE}`,
    `table inet ${PEER_TABLE} {`,
    ...chain('pre', PRE_HEAD, preRules()),
    ...chain('out', OUT_HEAD, outRules(uid)),
    '}',
    '',
  ].join('\n')
}

/** The unit that loads the table at boot, before Docker starts any container. */
export function peerFirewallUnit(): string {
  return [
    '# Written by `clawops agent install` (ADR 0015). Remove with `clawops agent uninstall`.',
    '[Unit]',
    'Description=clawops: keep containers and other users off the fleet peer port',
    'Before=docker.service tailscaled.service',
    '',
    '[Service]',
    'Type=oneshot',
    'RemainAfterExit=yes',
    `ExecStart=/usr/sbin/nft -f ${PEER_FW_RULES_PATH}`,
    `ExecStop=/usr/sbin/nft delete table inet ${PEER_TABLE}`,
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n')
}

/**
 * Installs nftables where the image lacks it (Debian 12's cloud image does, SP-16 finding 12),
 * creates the peer client's user, and prints its uid. Run as root.
 */
export function peerFirewallPrepareScript(): string {
  return [
    'set -eu',
    'if ! command -v nft >/dev/null 2>&1; then',
    '  command -v apt-get >/dev/null 2>&1 || { echo "nft is missing and this host has no apt-get to install nftables" >&2; exit 5; }',
    '  export DEBIAN_FRONTEND=noninteractive',
    '  apt-get install -y -q nftables >/dev/null 2>&1 || { apt-get update -q >/dev/null && apt-get install -y -q nftables >/dev/null; }',
    'fi',
    `id -u ${PEER_USER} >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin ${PEER_USER}`,
    `id -u ${PEER_USER}`,
  ].join('\n')
}

/**
 * Loads the table now and enables the unit for every boot after. The rules file replaces the
 * table atomically, so loading it directly never leaves a gap; `systemctl restart` would, between
 * its ExecStop and ExecStart.
 */
export function peerFirewallLoadScript(): string {
  return [
    'set -eu',
    'systemctl daemon-reload',
    `systemctl enable ${PEER_FW_UNIT} >/dev/null 2>&1`,
    `nft -f ${PEER_FW_RULES_PATH}`,
    `systemctl start ${PEER_FW_UNIT}`,
  ].join('\n')
}

export const PEER_TABLE_LIST_CMD = `nft list table inet ${PEER_TABLE}`

export function peerFirewallRemoveScript(): string {
  return [
    `systemctl disable --now ${PEER_FW_UNIT} >/dev/null 2>&1 || true`,
    `nft delete table inet ${PEER_TABLE} >/dev/null 2>&1 || true`,
    `rm -f ${PEER_FW_UNIT_PATH} ${PEER_FW_RULES_PATH}`,
    'systemctl daemon-reload',
    `userdel ${PEER_USER} >/dev/null 2>&1 || true`,
  ].join('\n')
}

export type PeerTableCheck = { ok: true } | { ok: false; reason: string }

/** A chain's lines as nft lists them, with the counters' running totals taken out. */
function chainBodies(listing: string): Map<string, string[]> | undefined {
  const lines = listing.split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'))
  if (lines[0] !== `table inet ${PEER_TABLE} {` || lines.at(-1) !== '}') return undefined
  const chains = new Map<string, string[]>()
  let current: string[] | undefined
  for (const line of lines.slice(1, -1)) {
    const open = /^chain (\S+) \{$/.exec(line)
    if (open) {
      if (current || chains.has(open[1]!)) return undefined
      current = []
      chains.set(open[1]!, current)
    } else if (line === '}') {
      if (!current) return undefined
      current = undefined
    } else {
      if (!current) return undefined
      current.push(line.replace(/ counter packets \d+ bytes \d+ /, ' counter '))
    }
  }
  return current ? undefined : chains
}

/**
 * Whether `nft list table inet clawops_peer` shows exactly the table install loads, for this uid.
 *
 * Exactly, not "contains": a rule inserted ahead of the drop, such as an `accept` for the bridge,
 * ends that chain's evaluation and lets the traffic through, so a table that still holds every
 * expected rule can be open. A listing that is empty or not this table fails.
 */
export function checkPeerTable(listing: string, uid: number): PeerTableCheck {
  const chains = chainBodies(listing)
  if (!chains) {
    return { ok: false, reason: `The firewall table inet ${PEER_TABLE} is missing.` }
  }
  const want = new Map([
    ['pre', [PRE_HEAD, ...preRules()]],
    ['out', [OUT_HEAD, ...outRules(uid)]],
  ])
  const names = [...chains.keys()].sort().join(',')
  if (names !== 'out,pre') {
    return { ok: false, reason: `The firewall table inet ${PEER_TABLE} has chains ${names || '(none)'}, not out and pre.` }
  }
  for (const [name, lines] of want) {
    const got = chains.get(name)!
    if (got.length !== lines.length || got.some((l, i) => l !== lines[i])) {
      return { ok: false, reason: `The firewall table inet ${PEER_TABLE} has been changed: its ${name} chain is not the one clawops installs.` }
    }
  }
  return { ok: true }
}
