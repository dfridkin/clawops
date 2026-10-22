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
import { callHostAgent, configureOperatorAgent, gatewayConfig, gatewayReady as ready, oc as ocOn, setConfig as setOn, type ToolCall } from './gateway.js'

const VERSION = process.env['CLAWOPS_E2E_OPENCLAW_VERSION'] ?? '2026.9.2'
const STACK = 'e2e-agent'
const ENTRY = path.resolve(__dirname, '../../../dist/cli.js')
const enabled = process.env['CLAWOPS_E2E_LOCAL'] === '1'

/** The JSON document in a command's output: pretty-printed, and with stderr after it. */
function jsonOf(out: string): { data: Record<string, unknown> } {
  return JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1))
}

describe.skipIf(!enabled)('clawops agent install on a real host', () => {
  let vm: VmTarget
  let home: string
  let env: Record<string, string>

  function clawops(...args: string[]): { code: number; out: string } {
    const r = spawnSync(process.execPath, [ENTRY, ...args], { env, encoding: 'utf-8', timeout: 1_200_000 })
    return { code: r.status ?? -1, out: `${r.stdout}\n${r.stderr}` }
  }

  const gatewayReady = () => ready(vm)
  const oc = (args: string) => ocOn(vm, args)
  const setConfig = (key: string, value: unknown) => setOn(vm, key, value)
  const callTools = (calls: ToolCall[]) => callHostAgent(vm, calls)

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

    await configureOperatorAgent(vm)
    const cfg = await gatewayConfig(vm) as { tools: unknown; agents: { entries?: unknown; list?: unknown } }
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
    expect(jsonOf(json.out).data.pendingHandoffs).toHaveLength(1)

    const ran = clawops('gateway', 'restart', '--stack', STACK)
    expect(ran.code, ran.out).toBe(0)
    await gatewayReady()

    const after = clawops('status', '--stack', STACK, '--json')
    const data = jsonOf(after.out).data
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
