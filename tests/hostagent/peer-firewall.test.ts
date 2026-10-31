// The fleet's firewall table and the fleet flags (ADR 0015 §1, §4). What a real kernel does with
// the table is the e2e suite's question (tests/e2e/local/peer-firewall.e2e.test.ts); this one asks
// whether install writes what SP-16 measured, and whether the check refuses every table but that.

import { describe, it, expect } from 'vitest'
import {
  peerTable, peerFirewallUnit, checkPeerTable, peerFirewallPrepareScript, peerFirewallLoadScript,
  PEER_PORT, PEER_FW_RULES_PATH,
} from '../../src/hostagent/peer-firewall.js'
import { validateFleetOpts, parsePeer, checkTailnet } from '../../src/hostagent/fleet.js'
import { listing, UID } from '../helpers/peer-table.js'

describe('the fleet firewall table', () => {
  it('names one interface per rule, because nft 1.0.2 rejects a wildcard inside a set', () => {
    const t = peerTable(UID)
    expect(t).not.toMatch(/iifname \{/)
    expect(t.match(/ drop$/gm)).toHaveLength(4)
    expect(t).toContain(`iifname "br-*" ip6 daddr fd7a:115c:a1e0::/48 tcp dport ${PEER_PORT} counter drop`)
    expect(t).toContain(`meta skuid != ${UID} counter reject with tcp reset`)
  })

  it('replaces the table in one transaction, creating it first so the delete cannot fail', () => {
    const lines = peerTable(UID).split('\n')
    const create = lines.indexOf('table inet clawops_peer')
    const del = lines.indexOf('delete table inet clawops_peer')
    const define = lines.indexOf('table inet clawops_peer {')
    expect(create).toBeGreaterThanOrEqual(0)
    expect(create).toBeLessThan(del)
    expect(del).toBeLessThan(define)
  })

  it('refuses to let root through, which every --network host container runs as', () => {
    expect(() => peerTable(0)).toThrow(/non-root/)
  })

  it('is loaded by a oneshot unit ordered before Docker starts any container', () => {
    const unit = peerFirewallUnit()
    expect(unit).toMatch(/^Before=docker\.service tailscaled\.service$/m)
    expect(unit).not.toMatch(/^After=/m)
    expect(unit).toMatch(/^Type=oneshot$/m)
    expect(unit).toMatch(/^RemainAfterExit=yes$/m)
    expect(unit).toContain(`ExecStart=/usr/sbin/nft -f ${PEER_FW_RULES_PATH}`)
  })

  it('installs nftables only where it is missing, and creates the peer client\'s user', () => {
    const s = peerFirewallPrepareScript()
    expect(s).toMatch(/if ! command -v nft/)
    expect(s).toContain('apt-get install -y -q nftables')
    expect(s).toMatch(/useradd --system .* clawops-peer/)
    expect(s.trim().split('\n').at(-1)).toBe('id -u clawops-peer')
  })

  it('loads the file directly rather than restarting the unit, which would leave a gap', () => {
    const s = peerFirewallLoadScript()
    expect(s).toContain(`nft -f ${PEER_FW_RULES_PATH}`)
    expect(s).not.toMatch(/systemctl restart/)
  })
})

describe('checking the table before trusting it', () => {
  it('accepts the table as nft lists it, counters and all', () => {
    expect(checkPeerTable(listing(), UID)).toEqual({ ok: true })
  })

  it('refuses when the table is missing', () => {
    expect(checkPeerTable('', UID).ok).toBe(false)
    expect(checkPeerTable('Error: No such file or directory\nlist table inet clawops_peer\n', UID).ok).toBe(false)
  })

  it('refuses a rule inserted ahead of the drops, which would end the chain early', () => {
    const r = checkPeerTable(listing(UID, (l) => [...l.slice(0, 3), '\t\tiifname "docker0" accept', ...l.slice(3)]), UID)
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/pre chain is not the one clawops installs/) })
  })

  it('refuses a missing rule', () => {
    expect(checkPeerTable(listing(UID, (l) => l.filter((x) => !x.includes('"br-*" ip6'))), UID).ok).toBe(false)
  })

  it('refuses a table that lets another uid through', () => {
    expect(checkPeerTable(listing(1001), UID).ok).toBe(false)
  })

  it('refuses an accept-all policy on either hook', () => {
    expect(checkPeerTable(listing(UID, (l) => l.map((x) => x.replace('reject with tcp reset', 'accept'))), UID).ok).toBe(false)
    expect(checkPeerTable(listing(UID, (l) => l.map((x) => x.replace('priority mangle', 'priority filter'))), UID).ok).toBe(false)
  })

  it('refuses an extra chain', () => {
    const extra = listing(UID, (l) => [...l.slice(0, -1), '\tchain early {', '\t\ttype filter hook prerouting priority raw; policy accept;', '\t}', '}'])
    expect(checkPeerTable(extra, UID)).toEqual({ ok: false, reason: expect.stringMatching(/has chains early,out,pre/) })
  })
})

describe('the fleet flags', () => {
  const base = { stack: 'us', strict: true, peers: [] as string[] }

  it('takes a tag and peers in their documented forms', () => {
    expect(validateFleetOpts({ ...base, servePeers: 'tag:clawops-agent', peers: ['eu=eu-gw', 'ap=ap-gw.tail1234.ts.net'] })).toEqual([])
    expect(parsePeer('eu=eu-gw')).toEqual({ stack: 'eu', node: 'eu-gw' })
  })

  it('refuses a tag without its prefix, a malformed peer, this stack, and a stack named twice', () => {
    const errors = validateFleetOpts({ ...base, servePeers: 'clawops-agent', peers: ['eu', 'us=us-gw', 'eu=a', 'eu=b', 'ap=bad name'] })
    expect(errors.join('\n')).toMatch(/--serve-peers "clawops-agent" is not a tailnet tag/)
    expect(errors.join('\n')).toMatch(/--peer "eu" is not in the form/)
    expect(errors.join('\n')).toMatch(/names this stack/)
    expect(errors.join('\n')).toMatch(/names stack "eu" more than once/)
    expect(errors.join('\n')).toMatch(/--peer "ap=bad name" is not in the form/)
  })

  it('refuses --peer without --strict', () => {
    expect(validateFleetOpts({ ...base, strict: false, peers: ['eu=eu-gw'] })).toEqual([expect.stringMatching(/--peer requires --strict/)])
    expect(validateFleetOpts({ ...base, strict: false, servePeers: 'tag:clawops-agent' })).toEqual([])
  })
})

describe('the tailnet check', () => {
  const status = (state: string, tags?: string[]) => JSON.stringify({ BackendState: state, Self: { HostName: 'eu-gw', ...(tags ? { Tags: tags } : {}) } })

  it('passes a running node that carries the tag', () => {
    expect(checkTailnet(status('Running', ['tag:clawops-agent']), 'tag:clawops-agent')).toEqual({ ok: true, tags: ['tag:clawops-agent'] })
  })

  it('refuses a running node without the tag, which is what a refused tag leaves', () => {
    const r = checkTailnet(status('Running'), 'tag:clawops-agent')
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/does not carry tag:clawops-agent \(its tags: none\)/) })
  })

  it('refuses a node that is not running, and a daemon that did not answer', () => {
    expect(checkTailnet(status('NeedsLogin'), undefined)).toEqual({ ok: false, reason: expect.stringMatching(/reports NeedsLogin/) })
    expect(checkTailnet('', undefined).ok).toBe(false)
  })

  it('needs no tag on a host that only queries peers', () => {
    expect(checkTailnet(status('Running'), undefined)).toEqual({ ok: true, tags: [] })
  })
})
