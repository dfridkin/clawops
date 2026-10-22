// A two-host fleet on a real tailnet: ADR 0015's verification list, each test breaking one
// condition alone.
//
// Two systemd targets, `us` and `eu`, each get a real OpenClaw gateway from `clawops up`, a real
// tailscaled joined to Headscale with a tagged key, and `clawops agent install --strict
// --serve-peers` (and, on us, `--peer eu=eu-gw`). Three more nodes are not fleet hosts: an
// untagged one, one with another tag, and a LAN neighbour on the same Docker network that is on
// no tailnet at all.
//
// The tailnet runs the default allow-all policy until the last test, so every refusal here is
// the host agent's own: on that policy the tag check is the only barrier (ADR §6). The last test
// loads the policy the docs give and checks the fleet still works under it.
//
// What only this suite shows: the peer listener started by the installed unit, a peer query run
// as clawops-peer under that unit's sandbox, the firewall table against a real gateway
// container across a reboot, and the refusals as Headscale's own whois reports the callers.
//
// Opt-in: `pnpm test:e2e:fleet`, not part of `test:e2e:local`. It pulls the OpenClaw image into
// each target, about 3 GB each, and removes both caches afterwards unless CLAWOPS_E2E_KEEP_CACHE=1.
// On a laptop with less than about 12 GB free, Docker Desktop stops partway: run it in CI, where
// the e2e workflow's fleet job frees the runner's disk first.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Network, type StartedNetwork } from 'testcontainers'
import { startVmTarget, stopVmTarget, TEST_KEY_PATH, type VmTarget } from './vm-container.js'
import { callHostAgent, configureOperatorAgent, setConfig } from './gateway.js'
import {
  BASE_DOMAIN, joinHost, peerUrl, postFromHost, startCaller, startHeadscale, toolCall,
  type Caller, type Headscale, type PostResult,
} from './tailnet.js'

const VERSION = process.env['CLAWOPS_E2E_OPENCLAW_VERSION'] ?? '2026.9.2'
const ENTRY = path.resolve(__dirname, '../../../dist/cli.js')
// Its own opt-in: two OpenClaw hosts need about 10 GB of disk, more than the other suites.
const enabled = process.env['CLAWOPS_E2E_LOCAL'] === '1' && process.env['CLAWOPS_E2E_FLEET'] === '1'
const TAG = 'tag:clawops-agent'
const PEER_PORT = 18800
const AUDIT = '/var/lib/clawops-agent/mcp-audit.log'
const HANDOFFS = '/var/lib/clawops-agent/handoffs.jsonl'

/** The allow-all policy a new tailnet starts with, plus the tag owners the keys need. */
const ALLOW_ALL = {
  tagOwners: { [TAG]: ['op@'], 'tag:other': ['op@'] },
  acls: [{ action: 'accept', src: ['*'], dst: ['*:*'] }],
}

/** ADR 0015 §6, as docs/fleet.md gives it, with this tailnet's operator. */
const DOCUMENTED = {
  tagOwners: { [TAG]: ['op@'], 'tag:other': ['op@'] },
  acls: [
    { action: 'accept', src: [TAG], dst: [`${TAG}:${PEER_PORT}`] },
    { action: 'accept', src: ['op@'], dst: [`${TAG}:22`] },
  ],
}

interface Host { stack: 'us' | 'eu'; hostname: string; vm: VmTarget; ips: string[] }

interface AuditLine { tool: string; result: string; peer?: { name: string; tags: string[] }; reason?: string; forwardedTo?: { stack: string; node: string }; args?: Record<string, unknown> }

describe.skipIf(!enabled)('a fleet of two host agents on a real tailnet', () => {
  let network: StartedNetwork
  let hs: Headscale
  let us: Host
  let eu: Host
  let untagged: Caller
  let otherTag: Caller
  let neighbour: Caller
  let home: string
  let env: Record<string, string>

  function clawops(...args: string[]): Promise<{ code: number; out: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [ENTRY, ...args], { env })
      let out = ''
      child.stdout.on('data', (d: Buffer) => { out += d.toString() })
      child.stderr.on('data', (d: Buffer) => { out += d.toString() })
      child.on('close', (code) => resolve({ code: code ?? -1, out }))
    })
  }

  async function audit(h: Host): Promise<AuditLine[]> {
    const out = (await h.vm.inspect(`cat ${AUDIT} 2>/dev/null`)).stdout
    return out.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as AuditLine)
  }

  const euUrl = () => peerUrl(eu.ips.find((ip) => !ip.includes(':'))!, PEER_PORT)

  /**
   * The doctor's Fleet policy check, from eu's own host agent. Read by pattern: the report is
   * trimmed to 8 KB for MCP, which can cut it short of valid JSON; this check is in the first remote section, which survives.
   */
  async function policyCheck(): Promise<{ name: string; status: string; detail: string }> {
    const [d] = await callHostAgent(eu.vm, [{ name: 'clawops_doctor' }])
    const m = /"name": "Fleet policy",\s*"status": "(\w+)",\s*"detail": "([^"]*)"/.exec(d!.text)
    if (!m) throw new Error(`no Fleet policy check in: ${d!.text.slice(0, 1500)}`)
    return { name: 'Fleet policy', status: m[1]!, detail: m[2]! }
  }

  /**
   * Wait until `post` gets any HTTP answer from eu's listener, and log how long that took. This
   * tailnet has no DERP relay, so a first contact, or one after tailscaled has idled the peer
   * out, waits for a direct path; a real tailnet relays those packets meanwhile.
   */
  async function reachable(what: string, post: () => Promise<PostResult>, seconds = 90): Promise<void> {
    const t0 = Date.now()
    for (let i = 0; Date.now() - t0 < seconds * 1000; i++) {
      const r = await post()
      if (r.status !== 'ERR') {
        process.stderr.write(`[fleet e2e] ${what} reached eu after ${Date.now() - t0} ms, ${i} failed attempts\n`)
        return
      }
      if (i === 0) await dumpState(`${what} could not reach eu (${r.code})`)
    }
    await dumpState(`${what} gave up`)
    throw new Error(`${what} never reached eu's peer port in ${seconds} s`)
  }

  /** What eu and us say about the peer port and each other, for a contact that failed. */
  async function dumpState(why: string): Promise<void> {
    const peers = `tailscale status --json | /opt/clawops-agent/node/bin/node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);for(const p of Object.values(j.Peer||{}))console.log(p.HostName,'online',p.Online,'active',p.Active,'inEngine',p.InEngine,'hs',p.LastHandshake,'rx',p.RxBytes,'tx',p.TxBytes,'cur',p.CurAddr)})"`
    const eu1 = await eu.vm.inspect([
      `ss -Hltn 'sport = :${PEER_PORT}'`, `ss -Htn state syn-recv 'sport = :${PEER_PORT}' | wc -l`,
      "grep -E '^TcpExt' /proc/net/netstat | awk 'NR==1{for(i=1;i<=NF;i++)h[i]=$i} NR==2{for(i=1;i<=NF;i++)if(h[i]~/Listen/)print h[i],$i}'",
      peers, 'nft list table inet clawops_peer 2>&1 | grep -E "counter packets [1-9]" ', 'journalctl -u clawops-agent -n 15 --no-pager 2>&1 | cut -c1-200',
    ].join('; echo --; '))
    const us1 = await us.vm.inspect(`${peers}; echo --; nft list table inet clawops_peer 2>&1 | grep -E "counter packets [1-9]"`)
    process.stderr.write(`[fleet e2e] ${why}\n== eu\n${eu1.stdout}\n== us\n${us1.stdout}\n`)
  }

  /** What a refused POST said, from the JSON-RPC error the listener answers with. */
  function refusal(r: PostResult): string {
    return (JSON.parse(r.body ?? '{}') as { error?: { message?: string } }).error?.message ?? ''
  }

  async function host(stack: Host['stack']): Promise<Host> {
    const hostname = `${stack}-gw`
    const vm = await startVmTarget(`${VERSION}-fleet-${stack}`, { network, hostname })
    const init = await clawops('init', '--non-interactive', '--provider', 'local', '--stack', stack, '--host', vm.host, '--ssh-user', vm.user, '--ssh-port', String(vm.port), '--key-path', path.join(env['CLAWOPS_HOME']!, 'id_ed25519'))
    expect(init.code, init.out).toBe(0)
    return { stack, hostname, vm, ips: [] }
  }

  beforeAll(async () => {
    if (!existsSync(ENTRY)) throw new Error(`${ENTRY} does not exist. Run \`pnpm build\` first.`)
    home = mkdtempSync(path.join(tmpdir(), 'clawops-e2e-fleet-'))
    const clawopsHome = path.join(home, '.clawops')
    mkdirSync(clawopsHome, { recursive: true })
    copyFileSync(TEST_KEY_PATH, path.join(clawopsHome, 'id_ed25519'))
    copyFileSync(`${TEST_KEY_PATH}.pub`, path.join(clawopsHome, 'id_ed25519.pub'))
    chmodSync(path.join(clawopsHome, 'id_ed25519'), 0o600)
    env = { ...(process.env as Record<string, string>), HOME: home, CLAWOPS_HOME: clawopsHome }

    network = await new Network().start()
    hs = await startHeadscale(network)
    await hs.setPolicy(ALLOW_ALL)
    const tagged = await hs.key([TAG])

    // init writes one config file, so one at a time; the two `up`s, which take minutes, together.
    us = await host('us')
    eu = await host('eu')
    const ups = await Promise.all([us, eu].map((h) => clawops('up', '--stack', h.stack, '--openclaw-version', VERSION)))
    for (const up of ups) expect(up.code, up.out).toBe(0)

    // After `up`, which installs Docker and with it iptables, as on a real host.
    for (const h of [us, eu]) h.ips = (await joinHost(h.vm, tagged, h.hostname)).ips
    untagged = await startCaller(network, 'laptop', await hs.key())
    otherTag = await startCaller(network, 'other', await hs.key(['tag:other']))
    neighbour = await startCaller(network, 'neighbour')

    // This tailnet has no DERP relay, so a node's first packets to another wait for a direct
    // path, which can take longer than a peer query's attempts. A real tailnet relays them
    // meanwhile. Each path the tests use is established first.
    const euIp = eu.ips.find((ip) => !ip.includes(':'))!
    const usIp = us.ips.find((ip) => !ip.includes(':'))!
    const pings = await Promise.all([
      us.vm.inspect(`tailscale ping --timeout=60s -c 60 ${euIp}`),
      eu.vm.inspect(`tailscale ping --timeout=60s -c 60 ${usIp}`),
      ...[untagged, otherTag].map(async (c) => {
        const r = await c.container.exec(['tailscale', 'ping', '--timeout=60s', '-c', '60', euIp])
        return { stdout: r.output, exitCode: r.exitCode }
      }),
    ])
    for (const p of pings) process.stderr.write(`[fleet e2e] ping exit ${p.exitCode}: ${p.stdout.trim().split('\n').slice(-2).join(' | ')}\n`)

    await Promise.all([us, eu].map((h) => configureOperatorAgent(h.vm, { strict: true })))
    const installEu = await clawops('agent', 'install', '--stack', 'eu', '--agent', 'ops', '--operator', 'telegram:12345', '--strict', '--serve-peers', TAG)
    expect(installEu.code, installEu.out).toBe(0)
    const installUs = await clawops('agent', 'install', '--stack', 'us', '--agent', 'ops', '--operator', 'telegram:12345', '--strict', '--serve-peers', TAG, '--peer', 'eu=eu-gw', '--allow', 'clawops_gateway_restart')
    expect(installUs.code, installUs.out).toBe(0)
  }, 3_600_000)

  afterAll(async () => {
    for (const c of [untagged, otherTag, neighbour]) await c?.container.stop({ remove: true }).catch(() => {})
    for (const h of [us, eu]) if (h) await stopVmTarget(h.vm)
    await hs?.container.stop({ remove: true }).catch(() => {})
    await network?.stop().catch(() => {})
    if (process.env['CLAWOPS_E2E_KEEP_CACHE'] !== '1') {
      for (const s of ['us', 'eu']) spawnSync('docker', ['volume', 'rm', `clawops-e2e-docker-${VERSION}-fleet-${s}`, `clawops-e2e-containerd-${VERSION}-fleet-${s}`])
    }
  }, 300_000)

  it('starts the peer listener from the installed unit, on the tailnet addresses only', async () => {
    const listening = (await eu.vm.inspect(`ss -Htln 'sport = :${PEER_PORT}'`)).stdout
    for (const ip of eu.ips) expect(listening).toContain(ip.includes(':') ? `[${ip}]:${PEER_PORT}` : `${ip}:${PEER_PORT}`)
    expect(listening).not.toMatch(new RegExp(`(0\\.0\\.0\\.0|\\*|\\[::\\]):${PEER_PORT}`))
    expect((await eu.vm.inspect('systemctl show clawops-agent -p After --value')).stdout).toContain('tailscaled.service')
  })

  it('forwards a read to the peer, run as clawops-peer, and both hosts log it', async () => {
    await reachable('us as clawops-peer', () => postFromHost(us.vm, euUrl(), toolCall('clawops_status'), 'clawops-peer'))
    const [status, config] = await callHostAgent(us.vm, [
      { name: 'clawops_gateway_status', arguments: { stackName: 'eu' } },
      { name: 'clawops_config_get', arguments: { stackName: 'eu', key: 'gateway.port' } },
    ])
    expect(status!.isError, status!.text).toBe(false)
    expect(status!.text).toMatch(new RegExp(`^Answered by peer eu \\(eu-gw\\.${BASE_DOMAIN.replace('.', '\\.')}\\.?\\)`))
    expect(status!.text).toContain('running')
    expect(config!.isError, config!.text).toBe(false)
    expect(config!.text).toMatch(/^Answered by peer eu/)

    const sent = (await audit(us)).filter((l) => l.forwardedTo)
    expect(sent.map((l) => l.tool)).toEqual(['clawops_gateway_status', 'clawops_config_get'])
    expect(sent[0]!.forwardedTo).toEqual({ stack: 'eu', node: 'eu-gw' })
    const answered = (await audit(eu)).filter((l) => l.peer && l.tool !== 'peer_listener')
    expect(answered.map((l) => l.tool)).toEqual(['clawops_gateway_status', 'clawops_config_get'])
    expect(answered[0]!.peer).toMatchObject({ name: expect.stringMatching(/^us-gw/), tags: [TAG] })
  }, 120_000)

  it('lists both hosts, and gives the fleet view from inside the gateway', async () => {
    const [listed, fleet] = await callHostAgent(us.vm, [
      { name: 'clawops_stacks_list' },
      { name: 'clawops_stacks_list', arguments: { fleet: true } },
    ])
    expect(listed!.isError, listed!.text).toBe(false)
    expect(JSON.parse(listed!.text)).toEqual({
      stacks: [
        { name: 'us', provider: 'local', isDefault: true, hostAgent: true },
        { name: 'eu', peer: 'eu-gw', answered: true, answeredBy: expect.stringMatching(/^eu-gw\./) },
      ],
    })
    expect(fleet!.isError, fleet!.text).toBe(false)
    const view = JSON.parse(fleet!.text) as { fleet: { hosts: Array<{ stack: string; state: string }>; agents: number; members: number } }
    expect(view.fleet.hosts.map((h) => [h.stack, h.state]), fleet!.text).toEqual([['us', 'ok'], ['eu', 'ok']])
    expect(view.fleet).toMatchObject({ agents: 2, members: 2 })
    // The operator's own view, over SSH, agrees.
    const op = await clawops('fleet', 'status', '--stack', 'us,eu')
    expect(op.code, op.out).toBe(0)
  }, 180_000)

  it('gives a peer the read tools only', async () => {
    const list = await postFromHost(us.vm, euUrl(), JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), 'clawops-peer')
    expect(list.status, JSON.stringify(list)).toBe(200)
    const names = (JSON.parse(list.body!) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name)
    expect(names).toHaveLength(12)
    expect(names).not.toContain('clawops_gateway_restart')
    const restart = await postFromHost(us.vm, euUrl(), toolCall('clawops_gateway_restart', { yes: true }), 'clawops-peer')
    expect(JSON.stringify(restart)).toMatch(/not found|Unknown tool/i)
  }, 60_000)

  it('refuses a destructive call naming a peer, records nothing on either host, and returns the operator\'s command', async () => {
    const before = (await audit(eu)).length
    const [r] = await callHostAgent(us.vm, [{ name: 'clawops_gateway_restart', arguments: { stackName: 'eu', yes: true } }])
    expect(r!.isError).toBe(true)
    expect(r!.text).toContain('clawops gateway restart --stack eu')
    expect(r!.text).toContain('Nothing was recorded on either host.')
    for (const h of [us, eu]) expect((await h.vm.inspect(`cat ${HANDOFFS} 2>/dev/null`)).stdout).not.toContain('--stack eu')
    expect((await audit(eu)).length).toBe(before)
  }, 60_000)

  it('refuses an untagged caller and a caller with another tag, and logs why', async () => {
    await reachable('the untagged node', () => untagged.post(euUrl(), toolCall('clawops_status')))
    await reachable('the tag:other node', () => otherTag.post(euUrl(), toolCall('clawops_status')))
    const a = await untagged.post(euUrl(), toolCall('clawops_status'))
    expect(a.status, JSON.stringify(a)).toBe(403)
    expect(refusal(a)).toMatch(new RegExp(`^Refused: laptop.* does not carry ${TAG} \\(its tags: none\\)`))
    const b = await otherTag.post(euUrl(), toolCall('clawops_status'))
    expect(b.status, JSON.stringify(b)).toBe(403)
    expect(refusal(b)).toMatch(/^Refused: other.* does not carry tag:clawops-agent \(its tags: tag:other\)/)
    const refused = (await audit(eu)).filter((l) => l.tool === 'peer_listener')
    expect(refused.map((l) => l.peer?.name.split('.')[0])).toEqual(expect.arrayContaining(['laptop', 'other']))
    // On this policy the tag check was the only barrier, and doctor says so.
    expect(await policyCheck()).toMatchObject({ status: 'warn', detail: expect.stringMatching(/every node on the tailnet can reach port 18800/) })
  }, 120_000)

  it('refuses the host itself', async () => {
    const r = await postFromHost(eu.vm, euUrl(), toolCall('clawops_status'), 'clawops-peer')
    expect(r.status, JSON.stringify(r)).toBe(403)
    expect(refusal(r)).toBe('Refused: the caller is this host. A host agent answers for itself without being its own peer.')
  }, 60_000)

  it('serves nothing to a LAN neighbour, on the LAN address or routed to the tailnet one', async () => {
    const lanIp = eu.vm.container.getIpAddress(network.getName())
    const direct = await neighbour.post(peerUrl(lanIp, PEER_PORT), toolCall('clawops_status'))
    expect(direct, JSON.stringify(direct)).toMatchObject({ status: 'ERR' })
    // A neighbour that routes the tailnet range at the host reaches the listener's address, and
    // whois finds no node behind it.
    const route = await neighbour.container.exec(['ip', 'route', 'add', '100.64.0.0/10', 'via', lanIp])
    expect(route.exitCode, route.output).toBe(0)
    const routed = await neighbour.post(euUrl(), toolCall('clawops_status'))
    expect(routed.status, JSON.stringify(routed)).not.toBe(200)
    if (routed.status === 403) expect(refusal(routed)).toMatch(/is not a tailnet node/)
  }, 60_000)

  it('refuses peer queries while another agent can run commands in the gateway container', async () => {
    const before = (await audit(eu)).length
    await setConfig(us.vm, 'agents.entries.main.tools.profile', 'coding')
    try {
      const [r] = await callHostAgent(us.vm, [{ name: 'clawops_gateway_status', arguments: { stackName: 'eu' } }])
      expect(r!.isError).toBe(true)
      expect(r!.text).toMatch(/Agent "main" can/)
      expect((await audit(eu)).length, 'the query reached the peer').toBe(before)
    } finally {
      await setConfig(us.vm, 'agents.entries.main.tools.profile', 'messaging')
    }
    const [again] = await callHostAgent(us.vm, [{ name: 'clawops_gateway_status', arguments: { stackName: 'eu' } }])
    expect(again!.isError, again!.text).toBe(false)
  }, 300_000)

  it('refuses a peer\'s next request once it is untagged, and ends a held connection within the cap', async () => {
    // A request that sends its headers and then never its body, as clawops-peer from us.
    const hold = `
      const s = require('net').connect(${PEER_PORT}, '${eu.ips.find((ip) => !ip.includes(':'))}')
      const t0 = Date.now()
      s.on('connect', () => s.write('POST / HTTP/1.1\\r\\nHost: eu\\r\\nContent-Type: application/json\\r\\nContent-Length: 100\\r\\n\\r\\n{'))
      s.on('close', () => { console.log(JSON.stringify({ heldMs: Date.now() - t0 })); process.exit(0) })
      s.on('error', () => {})
      setTimeout(() => { console.log(JSON.stringify({ heldMs: -1 })); process.exit(0) }, 120000)`
    const b64 = Buffer.from(hold).toString('base64')
    const held = us.vm.inspect(`echo ${b64} | base64 -d > /tmp/hold.js && chmod 0644 /tmp/hold.js && runuser -u clawops-peer -- /opt/clawops-agent/node/bin/node /tmp/hold.js`)
    await new Promise((r) => setTimeout(r, 2000))

    await hs.retag(us.hostname, ['tag:other'])
    try {
      let r: PostResult | undefined
      for (let i = 0; i < 30; i++) {
        r = await postFromHost(us.vm, euUrl(), toolCall('clawops_status'), 'clawops-peer')
        if (r.status === 403) break
        await new Promise((res) => setTimeout(res, 1000))
      }
      expect(r!.status, JSON.stringify(r)).toBe(403)
      expect(refusal(r!)).toMatch(/does not carry tag:clawops-agent \(its tags: tag:other\)/)
      // The forwarded path reports it the same way.
      const [fwd] = await callHostAgent(us.vm, [{ name: 'clawops_gateway_status', arguments: { stackName: 'eu' } }])
      expect(fwd!.isError).toBe(true)
      expect(fwd!.text).toMatch(/does not carry tag:clawops-agent/)

      const out = (await held).stdout
      const { heldMs } = JSON.parse(out.trim().split('\n').filter((l) => l.startsWith('{')).at(-1)!) as { heldMs: number }
      expect(heldMs, out).toBeGreaterThan(50_000)
      expect(heldMs).toBeLessThan(70_000)
    } finally {
      await hs.retag(us.hostname, [TAG])
    }
    for (let i = 0; i < 30; i++) {
      if ((await postFromHost(us.vm, euUrl(), toolCall('clawops_status'), 'clawops-peer')).status === 200) return
      await new Promise((res) => setTimeout(res, 1000))
    }
    throw new Error('us was not served again after it was retagged')
  }, 300_000)

  it('refuses peer queries while the firewall table is missing, when a container could reach the peer', async () => {
    const image = (await us.vm.inspect("docker inspect openclaw --format '{{.Config.Image}}'")).stdout.trim()
    const probe = `docker run --rm --entrypoint node ${image} -e "const s=require('net').connect({host:'${eu.ips.find((ip) => !ip.includes(':'))}',port:${PEER_PORT},timeout:8000});s.on('connect',()=>{console.log('REACHED');process.exit(0)});s.on('timeout',()=>{console.log('BLOCKED');process.exit(0)});s.on('error',(e)=>{console.log('BLOCKED '+e.code);process.exit(0)})"`
    expect((await us.vm.inspect(probe)).stdout).toContain('BLOCKED')

    expect((await us.vm.inspect('nft delete table inet clawops_peer')).exitCode).toBe(0)
    try {
      // What the table is for: without it, a gateway container reaches the peer as this host.
      await reachable('us as clawops-peer', () => postFromHost(us.vm, euUrl(), toolCall('clawops_status'), 'clawops-peer'))
      let seen = ''
      for (let i = 0; i < 5 && !seen.includes('REACHED'); i++) seen = (await us.vm.inspect(probe)).stdout
      if (!seen.includes('REACHED')) {
        const state = await us.vm.inspect(`nft list ruleset 2>&1 | head -80; echo ---; iptables-save 2>&1 | grep -v '^#' | head -80; echo ---; sysctl net.ipv4.ip_forward; ip route get ${eu.ips.find((ip) => !ip.includes(':'))} from 172.17.0.2 iif docker0 2>&1`)
        process.stderr.write(`[fleet e2e] the probe never reached eu with the table gone:\n${state.stdout}\n`)
      }
      expect(seen).toContain('REACHED')
      const [r] = await callHostAgent(us.vm, [{ name: 'clawops_gateway_status', arguments: { stackName: 'eu' } }])
      expect(r!.isError).toBe(true)
      expect(r!.text).toMatch(/^Refused: peer queries need the fleet firewall table/)
    } finally {
      expect((await us.vm.inspect('systemctl restart clawops-peer-fw.service')).exitCode).toBe(0)
    }
    expect((await us.vm.inspect(probe)).stdout).toContain('BLOCKED')
  }, 300_000)

  it('after a reboot, gateway containers with a restart policy never reach the peer, and peer queries work again', async () => {
    const image = (await us.vm.inspect("docker inspect openclaw --format '{{.Config.Image}}'")).stdout.trim()
    const target = eu.ips.find((ip) => !ip.includes(':'))
    const loop = `const net=require('net');setInterval(()=>{const s=net.connect({host:'${target}',port:${PEER_PORT},timeout:400});console.log('try '+Date.now());s.on('connect',()=>{console.log('REACHED '+Date.now());s.destroy()});s.on('timeout',()=>s.destroy());s.on('error',()=>{})},250)`
    // One on Docker's bridge, as a gateway runs; one on the host's network as root.
    for (const [name, net] of [['lurker-bridge', 'bridge'], ['lurker-host', 'host']] as const) {
      const r = await us.vm.inspect(`docker run -d --name ${name} --restart always --network ${net} --user 0 --entrypoint node ${image} -e "${loop}"`)
      expect(r.exitCode, r.stdout).toBe(0)
    }

    const pid1 = Number((await us.vm.inspect('ps -o etimes= -p 1')).stdout.trim())
    await us.vm.container.restart()
    for (let i = 0; i < 90; i++) {
      const s = (await us.vm.inspect('systemctl is-system-running')).stdout.trim()
      if (s === 'running' || s === 'degraded') break
      await new Promise((r) => setTimeout(r, 1000))
    }
    expect(Number((await us.vm.inspect('ps -o etimes= -p 1')).stdout.trim())).toBeLessThan(pid1)

    // The peer is reachable from this host again, as clawops-peer: so the lurkers' attempts from
    // here on are attempts the table stopped, not ones the tailnet could not carry yet.
    let reachableAt = 0
    for (let i = 0; i < 90 && !reachableAt; i++) {
      const r = await postFromHost(us.vm, euUrl(), toolCall('clawops_status'), 'clawops-peer')
      if (r.status === 200) reachableAt = Number((await us.vm.inspect('date +%s%3N')).stdout.trim())
      else await new Promise((res) => setTimeout(res, 1000))
    }
    expect(reachableAt, 'clawops-peer never reached eu after the reboot').toBeGreaterThan(0)
    await new Promise((r) => setTimeout(r, 10_000))

    for (const name of ['lurker-bridge', 'lurker-host']) {
      const logs = (await us.vm.inspect(`docker logs ${name} 2>&1`)).stdout
      expect(logs, `${name} reached the peer`).not.toContain('REACHED')
      const tries = logs.split('\n').filter((l) => l.startsWith('try ')).map((l) => Number(l.slice(4)))
      expect(tries.filter((t) => t > reachableAt).length, `${name} did not run after the reboot`).toBeGreaterThan(20)
    }
    await us.vm.inspect('docker rm -f lurker-bridge lurker-host')

    const [r] = await callHostAgent(us.vm, [{ name: 'clawops_gateway_status', arguments: { stackName: 'eu' } }])
    expect(r!.isError, r!.text).toBe(false)
    expect(r!.text).toMatch(/^Answered by peer eu/)
  }, 600_000)

  it('works under the documented tailnet policy, which keeps other nodes off the peer port', async () => {
    await hs.setPolicy(DOCUMENTED)
    let blocked: PostResult | undefined
    for (let i = 0; i < 30; i++) {
      blocked = await untagged.post(euUrl(), toolCall('clawops_status'))
      if (blocked.status === 'ERR') break
      await new Promise((r) => setTimeout(r, 1000))
    }
    expect(blocked, JSON.stringify(blocked)).toMatchObject({ status: 'ERR' })
    expect(await policyCheck()).toEqual({ name: 'Fleet policy', status: 'pass', detail: 'only tag:clawops-agent nodes can reach port 18800 (1 now)' })
    const [r] = await callHostAgent(us.vm, [{ name: 'clawops_gateway_status', arguments: { stackName: 'eu' } }])
    expect(r!.isError, r!.text).toBe(false)
    expect(r!.text).toMatch(/^Answered by peer eu/)
  }, 300_000)
})
