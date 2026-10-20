// `clawops fleet status` and clawops_stacks_list { fleet: true } (ADR 0015). Every host here is
// a fake that answers the status script with what a real host would print, so the question is
// whether each state of a host, and each mismatch between hosts, is reported, and reported on the
// right host.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { SshSession } from '../../src/transport/ssh.js'
import {
  assessHost, crossCheck, fleetStatus, fleetStatusFromConfig, fleetReadScript, type FleetHost, type FleetStatus,
} from '../../src/hostagent/fleet-status.js'
import { peerTable } from '../../src/hostagent/peer-firewall.js'
import { enterHostAgentMode, exitHostAgentModeForTests } from '../../src/hostagent/mode.js'
import type { HostAgentConfig } from '../../src/hostagent/config.js'
import { MINIMAL_CONFIG } from '../helpers/config.js'
import { NO_LOCAL_STATE, NO_OUTPUTS } from '../../src/transport/conn.js'

vi.mock('../../src/config/store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/config/store.js')>()),
  requireConfig: vi.fn(),
}))

const UID = 998
const MARK = '@@clawops-fleet:'

function config(stack: string, fleet?: HostAgentConfig['fleet']): HostAgentConfig {
  return {
    version: 1, stack, provider: 'aws', agentId: 'ops', operators: ['telegram:1'], allow: [], strict: true,
    installedAt: '2026-10-19T00:00:00.000Z', ...(fleet ? { fleet } : {}),
  }
}

/** The table as nft lists it: no file header, counters with totals. */
function listing(uid = UID): string {
  return peerTable(uid).split('\n').filter((l) => !/^(#|table inet clawops_peer$|delete )/.test(l))
    .map((l) => l.replace(' counter ', ' counter packets 4 bytes 240 ')).join('\n')
}

function tailnet(name: string, tags: string[], state = 'Running'): string {
  return JSON.stringify({ BackendState: state, Self: { DNSName: `${name}.tail1234.ts.net.`, HostName: name, Tags: tags } })
}

interface HostOut { config?: HostAgentConfig | string; service?: string; fwunit?: string; fw?: string; tailnet?: string }

/**
 * What the status script prints on a host holding these: each marker on a line of its own, then
 * the output as the command prints it. agent.json and tailscale's JSON end without a newline.
 */
function printed(o: HostOut): string {
  const cfg = o.config === undefined ? '' : typeof o.config === 'string' ? o.config : JSON.stringify(o.config, null, 2)
  const line = (v: string) => (v ? `${v}\n` : '')
  const parts: [string, string][] = [
    ['config', cfg], ['service', line(o.service ?? 'active')], ['fwunit', line(o.fwunit ?? '')], ['fw', line(o.fw ?? '')], ['tailnet', o.tailnet ?? ''],
  ]
  return parts.map(([k, v]) => `\n${MARK}${k}\n${v}`).join('')
}

/** A fleet member holding everything install leaves behind. */
function member(stack: string, opts: { serves?: string; peers?: { stack: string; node: string }[]; tags?: string[]; name?: string } = {}): HostOut {
  return {
    config: config(stack, { ...(opts.serves ? { serves: opts.serves } : {}), peers: opts.peers ?? [], peerUid: UID }),
    fwunit: 'enabled',
    fw: listing(),
    tailnet: tailnet(opts.name ?? `${stack}-gw`, opts.tags ?? (opts.serves ? [opts.serves] : [])),
  }
}

const TAG = 'tag:clawops-agent'

describe('reading the host', () => {
  it('reads every part in one script, as root, and does not stop at the first failure', () => {
    const s = fleetReadScript()
    for (const part of ['config', 'service', 'fwunit', 'fw', 'tailnet']) expect(s).toContain(`printf '\\n%s\\n' '${MARK}${part}'`)
    expect(s.split('\n').every((l) => l.endsWith('|| true'))).toBe(true)
    expect(s).toContain('cat /etc/clawops-agent/agent.json')
    expect(s).toContain('nft list table inet clawops_peer')
  })
})

describe('one host', () => {
  it('reports a stack with no host agent as such, not as a problem', () => {
    expect(assessHost('us', printed({ service: 'inactive' }))).toEqual({ stack: 'us', state: 'none', problems: [] })
  })

  it('reports a running host agent outside the fleet as ok, with what it serves', () => {
    expect(assessHost('us', printed({ config: config('us') }))).toEqual({
      stack: 'us', state: 'ok', service: 'active', agentId: 'ops', strict: true, installedAt: '2026-10-19T00:00:00.000Z', problems: [],
    })
  })

  it('reports a host agent whose service is not running', () => {
    const h = assessHost('us', printed({ config: config('us'), service: 'failed' }))
    expect(h).toMatchObject({ state: 'problems', service: 'failed', problems: [expect.stringMatching(/service is failed.*journalctl/)] })
  })

  it('reports an agent.json it cannot read, and one installed for another stack', () => {
    expect(assessHost('us', printed({ config: '{not json' }))).toMatchObject({ state: 'problems', problems: [expect.stringMatching(/not valid JSON/)] })
    expect(assessHost('us', printed({ config: config('eu') }))).toMatchObject({ state: 'problems', problems: [expect.stringMatching(/installed for stack "eu", not "us"/)] })
  })

  it('reports a fleet member with everything in place as ok, with its tag, peers and tailnet name', () => {
    const h = assessHost('us', printed(member('us', { serves: TAG, peers: [{ stack: 'eu', node: 'eu-gw' }] })))
    expect(h).toMatchObject({
      state: 'ok',
      problems: [],
      fleet: { serves: TAG, peers: [{ stack: 'eu', node: 'eu-gw' }], firewall: 'ok', tailnet: { state: 'Running', dnsName: 'us-gw.tail1234.ts.net', tags: [TAG] } },
    })
  })

  it('reports a firewall table that is missing or not the one install loaded', () => {
    expect(assessHost('us', printed({ ...member('us', { serves: TAG }), fw: '' }))).toMatchObject({
      state: 'problems', fleet: { firewall: expect.stringMatching(/missing/) }, problems: [expect.stringMatching(/missing.*agent install/)],
    })
    const other = assessHost('us', printed({ ...member('us', { serves: TAG }), fw: listing(1001) }))
    expect(other).toMatchObject({ state: 'problems', fleet: { firewall: expect.stringMatching(/has been changed/) } })
  })

  it('reports a boot unit that will not load the table at the next boot', () => {
    expect(assessHost('us', printed({ ...member('us', { serves: TAG }), fwunit: 'disabled' })).problems)
      .toEqual([expect.stringMatching(/clawops-peer-fw.service is disabled, so the table will not be loaded at the next boot/)])
  })

  it('reports a host off the tailnet, a tailscaled that did not answer, and a host that lost its tag', () => {
    expect(assessHost('us', printed({ ...member('us', { serves: TAG }), tailnet: tailnet('us-gw', [TAG], 'Stopped') })).problems)
      .toEqual([expect.stringMatching(/not on the tailnet: tailscaled reports Stopped/)])
    expect(assessHost('us', printed({ ...member('us', { serves: TAG }), tailnet: '' })).problems)
      .toEqual([expect.stringMatching(/did not answer/)])
    expect(assessHost('us', printed({ ...member('us', { serves: TAG }), tailnet: tailnet('us-gw', []) })).problems)
      .toEqual([expect.stringMatching(/no longer carries that tag itself \(its tags: none\)/)])
  })

  it('reports output with no sections as a host that did not run the script', () => {
    expect(assessHost('us', 'sudo: command not found\n').state).toBe('unreachable')
  })
})

describe('between hosts', () => {
  function run(hosts: Record<string, HostOut>): FleetHost[] {
    const read = Object.entries(hosts).map(([stack, o]) => assessHost(stack, printed(o)))
    crossCheck(read)
    return read
  }
  const caller = (peers: { stack: string; node: string }[], tags = [TAG]) => member('us', { peers, tags })

  it('passes a caller and a peer that fit: the peer serves the caller\'s tag under the name it is reached by', () => {
    for (const node of ['eu-gw', 'eu-gw.tail1234.ts.net', 'EU-GW']) {
      const [us, eu] = run({ us: caller([{ stack: 'eu', node }]), eu: member('eu', { serves: TAG }) })
      expect(us!.problems, node).toEqual([])
      expect(us!.state).toBe('ok')
      expect(eu!.state).toBe('ok')
    }
  })

  it('reports, on the caller, a peer with no host agent', () => {
    const [us] = run({ us: caller([{ stack: 'eu', node: 'eu-gw' }]), eu: {} })
    expect(us).toMatchObject({ state: 'problems', problems: ['Peer eu has no host agent.'] })
  })

  it('reports a peer installed without --serve-peers', () => {
    const [us, eu] = run({ us: caller([{ stack: 'eu', node: 'eu-gw' }]), eu: { config: config('eu') } })
    expect(us!.problems).toEqual([expect.stringMatching(/Peer eu does not serve peers/)])
    expect(eu!.state).toBe('ok')
  })

  it('reports a peer that answers a tag the caller does not carry', () => {
    const [us] = run({ us: caller([{ stack: 'eu', node: 'eu-gw' }], ['tag:other']), eu: member('eu', { serves: TAG }) })
    expect(us!.problems).toEqual([expect.stringMatching(/Peer eu answers only tag:clawops-agent, which this host does not carry \(its tags: tag:other\)/)])
  })

  it('reports a peer reached by a name it does not have on the tailnet', () => {
    const [us] = run({ us: caller([{ stack: 'eu', node: 'eu-old' }]), eu: member('eu', { serves: TAG }) })
    expect(us!.problems).toEqual([expect.stringMatching(/reached as "eu-old", but it is on the tailnet as "eu-gw.tail1234.ts.net"/)])
  })

  it('reports a peer that is not deployed', () => {
    const read = [assessHost('us', printed(caller([{ stack: 'eu', node: 'eu-gw' }]))), { stack: 'eu', state: 'undeployed' as const, problems: [] }]
    crossCheck(read)
    expect(read[0]).toMatchObject({ state: 'problems', problems: ['Peer eu is not deployed.'] })
  })

  it('says nothing about a peer it did not read, or could not reach', () => {
    const [us] = run({ us: caller([{ stack: 'ap', node: 'ap-gw' }]) })
    expect(us!.problems).toEqual([])
    const read = [assessHost('us', printed(caller([{ stack: 'eu', node: 'eu-gw' }]))), { stack: 'eu', state: 'unreachable' as const, problems: ['timeout'] }]
    crossCheck(read)
    expect(read[0]!.problems).toEqual([])
  })
})

describe('reading the fleet', () => {
  function fakeSession(stdout: string, code = 0, stderr = ''): SshSession {
    return { exec: vi.fn(async () => ({ stdout, stderr, code })) } as unknown as SshSession
  }

  it('reads every stack, keeps their order, and gives each session back', async () => {
    const released: string[] = []
    const hosts: Record<string, string> = {
      us: printed(member('us', { peers: [{ stack: 'eu', node: 'eu-gw' }], tags: [TAG] })),
      eu: printed(member('eu', { serves: TAG })),
      dev: printed({}),
    }
    const status = await fleetStatus(['us', 'eu', 'dev'], {
      open: async (stack) => {
        await new Promise((r) => setTimeout(r, stack === 'us' ? 20 : 0))
        return { session: fakeSession(hosts[stack]!), release: () => released.push(stack) }
      },
      concurrency: 2,
    })
    expect(status.hosts.map((h) => [h.stack, h.state])).toEqual([['us', 'ok'], ['eu', 'ok'], ['dev', 'none']])
    expect(status).toMatchObject({ agents: 2, members: 2 })
    expect(released.sort()).toEqual(['dev', 'eu', 'us'])
  })

  it('runs the script as root', async () => {
    const session = fakeSession(printed({}))
    await fleetStatus(['us'], { open: async () => ({ session, release: () => {} }) })
    expect(vi.mocked(session.exec).mock.calls[0]![0]).toMatch(/^sudo -n bash -c '/)
  })

  it('reports a host it cannot reach, and still reads the rest', async () => {
    const status = await fleetStatus(['us', 'eu'], {
      open: async (stack) => {
        if (stack === 'us') throw new Error(`${NO_OUTPUTS}\nmore detail`)
        return { session: fakeSession(printed({ config: config('eu') })), release: () => {} }
      },
    })
    expect(status.hosts[0]).toEqual({ stack: 'us', state: 'undeployed', problems: [] })
    expect(status.hosts[1]!.state).toBe('ok')
  })

  it('tells a stack with no host from a host that did not answer', async () => {
    const fail = (msg: string) => fleetStatus(['us'], { open: async () => { throw new Error(msg) } })
    expect((await fail(NO_LOCAL_STATE)).hosts[0]!.state).toBe('undeployed')
    const denied = (await fail('Could not read the state of stack "us": AccessDenied')).hosts[0]!
    expect(denied).toEqual({ stack: 'us', state: 'unreachable', problems: ['Could not read the state of stack "us": AccessDenied'] })
    expect((await fail('connect ECONNREFUSED 10.0.0.1:22')).hosts[0]!.state).toBe('unreachable')
  })

  it('gives up on a host that does not answer in time', async () => {
    const status = await fleetStatus(['us'], {
      open: (_stack, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
      timeoutMs: 50,
    })
    expect(status.hosts[0]).toEqual({ stack: 'us', state: 'unreachable', problems: ['No answer within 0 s.'] })
  })

  it('says so when reading needs passwordless sudo', async () => {
    const status = await fleetStatus(['us'], { open: async () => ({ session: fakeSession('', 1, 'sudo: a password is required\n'), release: () => {} }) })
    expect(status.hosts[0]).toEqual({ stack: 'us', state: 'unreachable', problems: ['Reading it needs passwordless sudo for the SSH user.'] })
  })
})

describe('the stacks it reads', () => {
  beforeEach(async () => {
    const { requireConfig } = await import('../../src/config/store.js')
    vi.mocked(requireConfig).mockReturnValue({
      ...MINIMAL_CONFIG,
      stacks: {
        us: { provider: 'aws', stateUrl: 's3://b', credentialsRef: { source: 'file', envVars: [] } },
        eu: { provider: 'aws', stateUrl: 's3://b', credentialsRef: { source: 'file', envVars: [] } },
      },
    } as never)
  })

  it('reads every stack in the config, or only the ones named', async () => {
    const opened: string[] = []
    const open = async (stack: string) => { opened.push(stack); return { session: { exec: async () => ({ stdout: printed({}), stderr: '', code: 0 }) } as unknown as SshSession, release: () => {} } }
    await fleetStatusFromConfig([], undefined, { open })
    expect(opened.sort()).toEqual(['eu', 'us'])
    opened.length = 0
    await fleetStatusFromConfig(['eu', 'eu'], undefined, { open })
    expect(opened).toEqual(['eu'])
  })

  it('refuses a stack the config does not name, before reaching any host', async () => {
    const open = vi.fn()
    expect(await fleetStatusFromConfig(['us', 'ap'], undefined, { open })).toEqual({
      ok: false, reason: 'No stack named "ap" in your clawops config. Stacks: us, eu.',
    })
    expect(open).not.toHaveBeenCalled()
  })
})

describe('clawops_stacks_list with fleet: true', () => {
  afterEach(() => exitHostAgentModeForTests())

  it('is refused on a host agent, which reads only its own host', async () => {
    enterHostAgentMode(config('us'))
    const { handleStacksList } = await import('../../src/mcp/tools/cli/stacks.js')
    const r = await handleStacksList({ fleet: true }, {} as McpServer)
    expect(r.isError).toBe(true)
    expect((r.content[0] as { text: string }).text).toMatch(/does not report the fleet.*clawops fleet status/)
  })

  it('fits a large fleet in 8 KB, keeping the hosts that have problems', async () => {
    const { fleetText } = await import('../../src/mcp/tools/cli/stacks.js')
    const ok = (i: number): FleetHost => ({
      ...assessHost(`s${i}`, printed(member(`s${i}`, { serves: TAG, peers: Array.from({ length: 5 }, (_, j) => ({ stack: `p${j}`, node: `p${j}-gw` })) }))),
    })
    const bad: FleetHost = { stack: 'broken', state: 'problems', problems: ['The firewall table inet clawops_peer is missing.'] }
    const status: FleetStatus = { hosts: [...Array.from({ length: 60 }, (_, i) => ok(i)), bad], agents: 61, members: 61 }
    const text = fleetText(status)
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(8 * 1024)
    const parsed = JSON.parse(text) as { fleet: FleetStatus; note?: string }
    expect(parsed.fleet.hosts.find((h) => h.stack === 'broken')).toEqual(bad)
    expect(parsed.note).toBeDefined()

    const small: FleetStatus = { hosts: [ok(1)], agents: 1, members: 1 }
    expect(JSON.parse(fleetText(small))).toEqual({ fleet: small })
  })
})
