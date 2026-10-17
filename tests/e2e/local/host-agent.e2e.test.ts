// `clawops agent install` against a real systemd host, and the installed host agent driven
// through the service it runs (ADR 0014 §7).
//
// The unit tests run install against a fake host. Only a real one answers what they cannot: whether
// the systemd sandbox leaves the read tools able to reach Docker and the state directory, whether
// the gateway container reaches the Docker bridge address, whether `openclaw config set` keeps the
// deny entries, and whether the bundle runs on the host's own Node with no node_modules.
//
// Opt-in: `pnpm build && pnpm test:e2e:local`.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { copyFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startVmTarget, stopVmTarget, TEST_KEY_PATH, type VmTarget } from './vm-container.js'

const VERSION = process.env['CLAWOPS_E2E_OPENCLAW_VERSION'] ?? '2026.9.2'
const STACK = 'e2e-agent'
const ENTRY = path.resolve(__dirname, '../../../dist/cli.js')
const enabled = process.env['CLAWOPS_E2E_LOCAL'] === '1'

/**
 * An MCP client run on the host with the host agent's own Node, against the service: what the
 * gateway's bridge does, minus a model. Prints one JSON line per call result.
 */
function mcpOnHost(calls: Array<{ name: string; arguments?: Record<string, unknown> }>): string {
  const js = `
const env=require('fs').readFileSync('/etc/clawops-agent/agent.env','utf8');
const token=/CLAWOPS_MCP_TOKEN=(\\S+)/.exec(env)[1];
const cfg=JSON.parse(require('fs').readFileSync('/etc/clawops-agent/agent.json','utf8'));
const url='http://'+cfg.listen.address+':'+cfg.listen.port+'/';
let sid;
async function rpc(method,params,id){
  const h={'content-type':'application/json',accept:'application/json, text/event-stream',authorization:'Bearer '+token};
  if(sid)h['mcp-session-id']=sid;
  const r=await fetch(url,{method:'POST',headers:h,body:JSON.stringify(id===undefined?{jsonrpc:'2.0',method,params}:{jsonrpc:'2.0',id,method,params})});
  sid=r.headers.get('mcp-session-id')||sid;
  const t=await r.text();
  const line=t.split('\\n').find(l=>l.startsWith('data: '));
  return line?JSON.parse(line.slice(6)):(t?JSON.parse(t):null);
}
(async()=>{
  await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'e2e',version:'1'}},1);
  await rpc('notifications/initialized',{});
  let id=2;
  for(const c of ${JSON.stringify(calls)}){
    const r=await rpc('tools/call',{name:c.name,arguments:c.arguments||{}},id++);
    console.log(JSON.stringify({name:c.name,isError:!!r.result?.isError,text:(r.result?.content||[]).map(x=>x.text).join('\\n')}));
  }
})().catch(e=>{console.error(e);process.exit(1)});`
  return js
}

describe.skipIf(!enabled)('clawops agent install on a real host', () => {
  let vm: VmTarget
  let home: string
  let env: Record<string, string>

  function clawops(...args: string[]): { code: number; out: string } {
    const r = spawnSync(process.execPath, [ENTRY, ...args], { env, encoding: 'utf-8', timeout: 1_200_000 })
    return { code: r.status ?? -1, out: `${r.stdout}\n${r.stderr}` }
  }

  async function gatewayReady(): Promise<void> {
    for (let i = 0; i < 90; i++) {
      const probe = await vm.inspect('curl -s --max-time 3 http://127.0.0.1:18789/startupz; docker exec openclaw true && echo EXEC-OK')
      if (/"status"\s*:\s*"started"/.test(probe.stdout) && probe.stdout.includes('EXEC-OK')) return
      await new Promise((r) => setTimeout(r, 2000))
    }
    throw new Error('the gateway did not come back')
  }

  /**
   * Some keys make the gateway restart itself, and the `docker exec` that set one is killed with
   * it (137). The write landed before the restart, so wait for the gateway and carry on; the
   * assertions that matter read the configuration back.
   */
  async function oc(args: string): Promise<{ stdout: string; exitCode: number }> {
    const r = await vm.inspect(`docker exec openclaw openclaw ${args}`)
    if (r.exitCode === 137) {
      await gatewayReady()
      return { stdout: r.stdout, exitCode: 0 }
    }
    if (/config set/.test(args)) await gatewayReady()
    return r
  }

  /** Set a key and read the file back until it holds the value: a restart can lose a write. */
  async function setConfig(key: string, value: unknown): Promise<void> {
    let held: unknown
    for (let i = 0; i < 5; i++) {
      await oc(`config set ${key} '${JSON.stringify(value)}' --strict-json`)
      const cfg = JSON.parse((await vm.inspect('cat /var/lib/clawops/openclaw/openclaw.json')).stdout) as Record<string, unknown>
      held = key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], cfg)
      if (JSON.stringify(held) === JSON.stringify(value)) return
      await new Promise((r) => setTimeout(r, 3000))
    }
    throw new Error(`${key} did not keep ${JSON.stringify(value)}; the file holds ${JSON.stringify(held)}`)
  }

  async function callTools(calls: Array<{ name: string; arguments?: Record<string, unknown> }>) {
    // Base64 into a file, so no shell quoting stands between the script and Node.
    const b64 = Buffer.from(mcpOnHost(calls)).toString('base64')
    const r = await vm.inspect(`echo ${b64} | base64 -d > /root/mcpcall.js && /opt/clawops-agent/node/bin/node /root/mcpcall.js`)
    expect(r.exitCode, r.stdout).toBe(0)
    return r.stdout.trim().split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as { name: string; isError: boolean; text: string })
  }

  beforeAll(async () => {
    if (!existsSync(ENTRY)) throw new Error(`${ENTRY} does not exist. Run \`pnpm build\` first.`)
    vm = await startVmTarget(VERSION)
    home = mkdtempSync(path.join(tmpdir(), 'clawops-e2e-agent-'))
    const clawopsHome = path.join(home, '.clawops')
    mkdirSync(clawopsHome, { recursive: true })
    copyFileSync(TEST_KEY_PATH, path.join(clawopsHome, 'id_ed25519'))
    copyFileSync(`${TEST_KEY_PATH}.pub`, path.join(clawopsHome, 'id_ed25519.pub'))
    chmodSync(path.join(clawopsHome, 'id_ed25519'), 0o600)
    env = { ...(process.env as Record<string, string>), HOME: home, CLAWOPS_HOME: clawopsHome }

    const init = clawops('init', '--non-interactive', '--provider', 'local', '--stack', STACK, '--host', vm.host, '--ssh-user', vm.user, '--ssh-port', String(vm.port), '--key-path', path.join(clawopsHome, 'id_ed25519'))
    expect(init.code, init.out).toBe(0)
    const up = clawops('up', '--stack', STACK, '--openclaw-version', VERSION)
    expect(up.code, up.out).toBe(0)

    // An operator-only agent, configured the way the docs tell an operator to.
    for (const cmd of [
      'agents add ops --non-interactive --workspace /home/node/.openclaw/workspace-ops',
      `config set bindings '[{"agentId":"ops","match":{"channel":"telegram","peer":{"kind":"direct","id":"12345"}}}]' --strict-json`,
      `config set channels.telegram '{"enabled":false,"dmPolicy":"pairing"}' --strict-json`,
      'config set tools.agentToAgent.enabled false --strict-json',
      'config set tools.sessions.visibility \'"agent"\' --strict-json',
    ]) {
      const r = await oc(cmd)
      expect(r.exitCode, `${cmd}\n${r.stdout}`).toBe(0)
    }
    const cfg = JSON.parse((await vm.inspect('cat /var/lib/clawops/openclaw/openclaw.json')).stdout)
    expect(cfg.tools).toMatchObject({ agentToAgent: { enabled: false }, sessions: { visibility: 'agent' } })
    expect(cfg.agents.entries ?? cfg.agents.list).toBeTruthy()
  }, 1_800_000)

  afterAll(async () => {
    if (vm) await stopVmTarget(vm)
  })

  it('refuses while the routing would let others reach the agent, and installs nothing', async () => {
    await setConfig('channels.telegram.dmPolicy', 'open')
    const r = clawops('agent', 'install', '--stack', STACK, '--agent', 'ops', '--operator', 'telegram:12345')
    await setConfig('channels.telegram.dmPolicy', 'pairing')
    expect(r.code, r.out).toBe(1)
    expect(r.out).toMatch(/dmPolicy is "open"/)
    expect((await vm.inspect('test -e /etc/systemd/system/clawops-agent.service && echo yes || echo no')).stdout.trim()).toBe('no')
  })

  it('installs, denies clawops to the other agents, and the gateway reaches it', async () => {
    const r = clawops('agent', 'install', '--stack', STACK, '--agent', 'ops', '--operator', 'telegram:12345', '--allow', 'clawops_gateway_restart')
    expect(r.code, r.out).toBe(0)
    expect(r.out).toMatch(/the gateway reached it/)
    expect(r.out).toMatch(/"main" can run commands/)

    expect((await vm.inspect('systemctl is-active clawops-agent')).stdout.trim()).toBe('active')
    expect((await oc('mcp show clawops')).exitCode).toBe(0)
    const deny = await oc('config get agents.entries.main.tools.deny')
    expect(deny.stdout).toContain('clawops__*')
    // Nothing from npm on the host: no node_modules anywhere under the install.
    expect((await vm.inspect('find /opt/clawops-agent/lib -name node_modules | wc -l')).stdout.trim()).toBe('0')
  }, 1_200_000)

  it('serves its read tools from inside the sandbox, and hands off what it is allowed', async () => {
    const results = await callTools([
      { name: 'clawops_status' },
      { name: 'clawops_gateway_status' },
      { name: 'clawops_doctor' },
      { name: 'clawops_config_get', arguments: { key: 'gateway.port' } },
      { name: 'clawops_gateway_restart', arguments: { yes: true } },
    ])
    const by = Object.fromEntries(results.map((r) => [r.name, r]))
    for (const r of results) expect(r.isError, `${r.name}: ${r.text}`).toBe(false)
    expect(JSON.parse(by['clawops_status']!.text)).toMatchObject({ stack: STACK, hostAgent: { agentId: 'ops' } })
    expect(by['clawops_gateway_status']!.text).toContain('running')
    expect(by['clawops_doctor']!.text).not.toMatch(/Cannot find (package|module)/)
    expect(by['clawops_gateway_restart']!.text).toContain(`clawops gateway restart --stack ${STACK}`)
    // The handoff was recorded where the sandbox lets it write, and nothing restarted.
    expect((await vm.inspect('cat /var/lib/clawops-agent/handoffs.jsonl')).stdout).toContain('gateway restart')
  }, 600_000)

  it('shows the operator the request in `status`, and clears it once they run the command', async () => {
    const shown = clawops('status', '--stack', STACK)
    expect(shown.code, shown.out).toBe(0)
    expect(shown.out).toContain(`${STACK} has 1 request from its agent:\n    clawops gateway restart --stack ${STACK}`)
    const json = clawops('status', '--stack', STACK, '--json')
    expect(JSON.parse(json.out.trim().split('\n')[0]!).data.pendingHandoffs).toHaveLength(1)

    const ran = clawops('gateway', 'restart', '--stack', STACK)
    expect(ran.code, ran.out).toBe(0)
    await gatewayReady()

    const after = clawops('status', '--stack', STACK, '--json')
    const data = JSON.parse(after.out.trim().split('\n')[0]!).data
    expect(data.pendingHandoffs, after.out).toBeUndefined()
    expect(data.pendingHandoffsError, after.out).toBeUndefined()
    // The host agent's own status agrees: the clear is in the file both read.
    const [own] = await callTools([{ name: 'clawops_status' }])
    expect(JSON.parse(own!.text).pendingHandoffs).toEqual([])
  }, 600_000)

  it('refuses every call once a group is bound to the agent, and serves again once it is removed', async () => {
    const direct = { agentId: 'ops', match: { channel: 'telegram', peer: { kind: 'direct', id: '12345' } } }
    await setConfig('bindings', [direct, { agentId: 'ops', match: { channel: 'telegram', peer: { kind: 'group', id: '-100' } } }])
    const [refused] = await callTools([{ name: 'clawops_status' }])
    expect(refused!.isError).toBe(true)
    expect(refused!.text).toMatch(/group conversation/)

    await setConfig('bindings', [direct])
    const [served] = await callTools([{ name: 'clawops_status' }])
    expect(served!.isError, served!.text).toBe(false)
  }, 600_000)

  it('uninstalls, unwires the gateway and keeps the audit log', async () => {
    const r = clawops('agent', 'uninstall', '--stack', STACK)
    expect(r.code, r.out).toBe(0)
    expect((await vm.inspect('systemctl is-active clawops-agent')).stdout.trim()).not.toBe('active')
    expect((await oc('mcp show clawops')).exitCode).not.toBe(0)
    expect((await vm.inspect('test -d /opt/clawops-agent && echo yes || echo no')).stdout.trim()).toBe('no')
    expect((await vm.inspect('test -f /var/lib/clawops-agent/handoffs.jsonl && echo yes || echo no')).stdout.trim()).toBe('yes')
  }, 600_000)
})
