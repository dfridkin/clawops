// The fleet firewall table as `nft list table inet clawops_peer` prints it, for tests that read
// one back (peer-firewall.ts, peer-repair.ts, doctor).

import { PEER_PORT } from '../../src/hostagent/peer-firewall.js'

export const UID = 998

/** The table as `nft list` prints it after some traffic: tabs, and counters with running totals. */
export function listing(uid = UID, edit: (lines: string[]) => string[] = (l) => l): string {
  const lines = [
    'table inet clawops_peer {',
    '\tchain pre {',
    '\t\ttype filter hook prerouting priority mangle; policy accept;',
    `\t\tiifname "docker0" ip daddr 100.64.0.0/10 tcp dport ${PEER_PORT} counter packets 12 bytes 720 drop`,
    `\t\tiifname "br-*" ip daddr 100.64.0.0/10 tcp dport ${PEER_PORT} counter packets 3 bytes 180 drop`,
    `\t\tiifname "docker0" ip6 daddr fd7a:115c:a1e0::/48 tcp dport ${PEER_PORT} counter packets 0 bytes 0 drop`,
    `\t\tiifname "br-*" ip6 daddr fd7a:115c:a1e0::/48 tcp dport ${PEER_PORT} counter packets 0 bytes 0 drop`,
    '\t}',
    '',
    '\tchain out {',
    '\t\ttype filter hook output priority filter; policy accept;',
    `\t\toifname "tailscale0" tcp dport ${PEER_PORT} meta skuid != ${uid} counter packets 30 bytes 1860 reject with tcp reset`,
    '\t}',
    '}',
  ]
  return edit(lines).join('\n') + '\n'
}
