// `clawops fleet status`: what it prints and how it exits. What it reads is fleet-status.test.ts's.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { FleetHost, FleetStatusResult } from '../../src/hostagent/fleet-status.js'

const h = vi.hoisted(() => ({ fleetStatusFromConfig: vi.fn() }))
vi.mock('../../src/hostagent/fleet-status.js', () => ({ fleetStatusFromConfig: h.fleetStatusFromConfig }))
vi.mock('../../src/transport/pool.js', () => ({ drainPool: vi.fn() }))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRunFn = (ctx: any) => Promise<void>

class Exit extends Error { constructor(public code: number) { super(`exit ${code}`) } }

async function run(args: Record<string, unknown>, result: FleetStatusResult): Promise<{ out: string; code: number }> {
  h.fleetStatusFromConfig.mockResolvedValue(result)
  const writes: string[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { writes.push(String(s)); return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => { writes.push(String(s)); return true })
  vi.spyOn(console, 'log').mockImplementation((...a) => { writes.push(a.join(' ')) })
  vi.spyOn(console, 'error').mockImplementation((...a) => { writes.push(a.join(' ')) })
  vi.spyOn(process, 'exit').mockImplementation(((code: number) => { throw new Exit(code) }) as never)
  const { default: cmd } = await import('../../src/cli/commands/fleet.js')
  const status = (cmd.subCommands as Record<string, { run: AnyRunFn }>)['status']!
  let code = 0
  try {
    await status.run({ args: { _: [], ...args } })
  } catch (e) {
    if (!(e instanceof Exit)) throw e
    code = e.code
  }
  return { out: writes.join('\n'), code }
}

const member: FleetHost = {
  stack: 'us', state: 'ok', service: 'active', agentId: 'ops', strict: true, problems: [],
  fleet: { serves: 'tag:clawops-agent', peers: [{ stack: 'eu', node: 'eu-gw' }], firewall: 'ok', tailnet: { state: 'Running', dnsName: 'us-gw.tail1234.ts.net', tags: ['tag:clawops-agent'] } },
}
const status = (hosts: FleetHost[]): FleetStatusResult => ({ ok: true, status: { hosts, agents: hosts.filter((x) => x.agentId).length, members: hosts.filter((x) => x.fleet).length } })

describe('fleet status', () => {
  beforeEach(() => { vi.resetModules(); h.fleetStatusFromConfig.mockReset() })
  afterEach(() => { vi.restoreAllMocks() })

  it('lists each stack with its host agent and fleet, and exits 0 when nothing is wrong', async () => {
    const { out, code } = await run({}, status([member, { stack: 'dev', state: 'none', problems: [] }, { stack: 'old', state: 'undeployed', problems: [] }]))
    expect(code).toBe(0)
    expect(out).toMatch(/us\s+ok\s+active\s+ops \(strict\)\s+serves tag:clawops-agent; peers eu\s+ok\s+us-gw\.tail1234\.ts\.net/)
    expect(out).toMatch(/dev\s+no host agent/)
    expect(out).toMatch(/old\s+not deployed/)
    expect(out).toContain('1 host agent on 3 stacks, 1 in the fleet.')
  })

  it('prints each problem against its stack and exits 1', async () => {
    const bad: FleetHost = { ...member, state: 'problems', problems: ['Peer eu does not serve peers: its host agent was installed without --serve-peers.'] }
    const { out, code } = await run({}, status([bad]))
    expect(code).toBe(1)
    expect(out).toContain('us: Peer eu does not serve peers')
  })

  it('exits 1 when a host did not answer', async () => {
    const { code } = await run({}, status([{ stack: 'eu', state: 'unreachable', problems: ['No answer within 30 s.'] }]))
    expect(code).toBe(1)
  })

  it('passes the stacks it was given, comma-separated or repeated', async () => {
    await run({ stack: ['us,eu', 'ap'] }, status([]))
    expect(h.fleetStatusFromConfig.mock.calls[0]![0]).toEqual(['us', 'eu', 'ap'])
  })

  it('prints the status as JSON with --json', async () => {
    const { out, code } = await run({ json: true }, status([member]))
    expect(code).toBe(0)
    expect(JSON.parse(out.slice(out.indexOf('{')))).toMatchObject({ ok: true, data: { hosts: [{ stack: 'us', state: 'ok' }] } })
  })

  it('refuses a stack the config does not name, with exit 2', async () => {
    const { out, code } = await run({ stack: 'ap' }, { ok: false, reason: 'No stack named "ap" in your clawops config. Stacks: us.' })
    expect(code).toBe(2)
    expect(out).toContain('No stack named "ap"')
  })
})
