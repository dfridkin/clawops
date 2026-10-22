// The doctor's reading of the tailnet policy, from the packet filter tailscaled serves. The
// allow-all rule is the one tailscaled returned on Headscale 0.27.1 for the default policy.

import { describe, it, expect } from 'vitest'
import { parseRange, peerPolicyCheck, sourcesToPort, type FilterRule } from '../../src/hostagent/peer-policy.js'

const TAG = 'tag:clawops-agent'
const ALLOW_ALL: FilterRule[] = [{
  SrcIPs: ['0.0.0.0/0', '::/0'],
  DstPorts: [{ IP: '0.0.0.0/0', Ports: { First: 0, Last: 65535 } }, { IP: '::/0', Ports: { First: 0, Last: 65535 } }],
  IPProto: [6, 17],
}]

function status(peers: Array<{ name: string; ips: string[]; tags?: string[] }>) {
  return JSON.stringify({
    Self: { TailscaleIPs: ['100.64.0.2', 'fd7a:115c:a1e0::2'] },
    Peer: Object.fromEntries(peers.map((p, i) => [`k${i}`, { DNSName: `${p.name}.fleet.test.`, TailscaleIPs: p.ips, ...(p.tags ? { Tags: p.tags } : {}) }])),
  })
}

const US = { name: 'us-gw', ips: ['100.64.0.1', 'fd7a:115c:a1e0::1'], tags: [TAG] }
const LAPTOP = { name: 'laptop', ips: ['100.64.0.3', 'fd7a:115c:a1e0::3'] }
const NODES = status([US, LAPTOP])

/** The documented policy, as the control server compiles it for eu: us may reach 18800, laptop 22. */
const DOCUMENTED: FilterRule[] = [
  { SrcIPs: ['100.64.0.1', 'fd7a:115c:a1e0::1'], DstPorts: [{ IP: '100.64.0.2', Ports: { First: 18800, Last: 18800 } }, { IP: 'fd7a:115c:a1e0::2', Ports: { First: 18800, Last: 18800 } }] },
  { SrcIPs: ['100.64.0.3', 'fd7a:115c:a1e0::3'], DstPorts: [{ IP: '100.64.0.2', Ports: { First: 22, Last: 22 } }] },
]

describe('reading filter addresses', () => {
  it('reads addresses, prefixes, ranges and *, in both families', () => {
    expect(parseRange('100.64.0.1')).toEqual([{ v6: false, lo: 0x64400001n, hi: 0x64400001n }])
    expect(parseRange('100.64.0.0/10')).toEqual([{ v6: false, lo: 0x64400000n, hi: 0x647fffffn }])
    expect(parseRange('100.64.0.1-100.64.0.9')).toEqual([{ v6: false, lo: 0x64400001n, hi: 0x64400009n }])
    expect(parseRange('::/0')).toEqual([{ v6: true, lo: 0n, hi: (1n << 128n) - 1n }])
    expect(parseRange('fd7a:115c:a1e0::1')[0]!.lo).toBe(0xfd7a115ca1e000000000000000000001n)
    expect(parseRange('*')).toHaveLength(2)
    expect(parseRange('nonsense')).toEqual([])
    expect(parseRange('1.2.3.4/33')).toEqual([])
  })

  it('takes only rules that reach this host on TCP at the port', () => {
    expect(sourcesToPort(DOCUMENTED, ['100.64.0.2'], 18800)).toEqual(parseRange('100.64.0.1').concat(parseRange('fd7a:115c:a1e0::1')))
    expect(sourcesToPort(DOCUMENTED, ['100.64.0.9'], 18800)).toEqual([])
    expect(sourcesToPort([{ ...ALLOW_ALL[0]!, IPProto: [17] }], ['100.64.0.2'], 18800)).toEqual([])
  })
})

describe('the doctor check', () => {
  it('warns on the allow-all policy that the tag check is the only barrier', () => {
    expect(peerPolicyCheck(JSON.stringify(ALLOW_ALL), NODES, TAG)).toEqual({
      name: 'Fleet policy',
      status: 'warn',
      detail: 'every node on the tailnet can reach port 18800, as on the default allow-all policy; the host agent\'s tag check is the only barrier',
      remedy: expect.stringMatching(/Tailnet policy/),
    })
  })

  it('passes on the documented policy', () => {
    expect(peerPolicyCheck(JSON.stringify(DOCUMENTED), NODES, TAG)).toEqual({ name: 'Fleet policy', status: 'pass', detail: 'only tag:clawops-agent nodes can reach port 18800 (1 now)' })
  })

  it('names the untagged nodes a narrower policy still lets through', () => {
    const rules = [...DOCUMENTED, { SrcIPs: ['100.64.0.3'], DstPorts: [{ IP: '*', Ports: { First: 18000, Last: 19000 } }] }]
    expect(peerPolicyCheck(JSON.stringify(rules), NODES, TAG)).toMatchObject({ status: 'warn', detail: '1 node without tag:clawops-agent can reach port 18800: laptop.fleet.test; the host agent\'s tag check refuses them' })
  })

  it('warns when no peer can reach the port at all', () => {
    expect(peerPolicyCheck(JSON.stringify([DOCUMENTED[1]]), NODES, TAG)).toMatchObject({ status: 'warn', detail: expect.stringMatching(/no node on the tailnet can reach port 18800/) })
  })

  it('says so when the filter or the status cannot be read, rather than passing', () => {
    expect(peerPolicyCheck('', NODES, TAG)).toMatchObject({ status: 'warn', detail: expect.stringMatching(/could not read/) })
    expect(peerPolicyCheck('{"error":"denied"}', NODES, TAG)).toMatchObject({ status: 'warn', detail: expect.stringMatching(/could not read/) })
    expect(peerPolicyCheck(JSON.stringify(DOCUMENTED), '', TAG)).toMatchObject({ status: 'warn', detail: expect.stringMatching(/could not read/) })
  })
})
