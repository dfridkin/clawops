// clawops_migrate against a real 1.x deployment, made by the clawops that made them.
//
// A migration's whole job is to read a host it did not create — the 1.x layout, its config,
// its container — and the unit tests can only describe that host from memory. So the 1.x
// deployment here is produced by clawops 1.7.9 itself, from npm, against the systemd target;
// then the server under test migrates it over MCP, the way an agent would.
//
// This is also the only path that runs in the background: clawops_migrate hands back a taskId
// after its synchronous window and finishes on its own SSH connection, so the test polls
// clawops_task_status the way a client has to.
//
// Opt-in: `pnpm build && pnpm test:e2e:local`. Needs network for npx and two image pulls.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ElicitRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { startVmTarget, stopVmTarget, TEST_KEY_PATH, type VmTarget } from './vm-container.js'

const LEGACY_CLI = process.env['CLAWOPS_E2E_LEGACY_CLI'] ?? '@clawops/cli@1.7.9'
const LEGACY_VERSION = '2026.7.1-2'
const TARGET_VERSION = '2026.9.2'
const STACK = 'e2e-legacy'
const ENTRY = path.resolve(__dirname, '../../../dist/cli.js')
const LONG = { timeout: 1_200_000, resetTimeoutOnProgress: true }

const enabled = process.env['CLAWOPS_E2E_LOCAL'] === '1'

describe.skipIf(!enabled)('clawops_migrate against a deployment clawops 1.7.9 made', () => {
  let vm: VmTarget
  let clawopsHome: string
  let client: Client
  const elicitations: string[] = []
  let answer: 'accept' | 'decline' = 'decline'

  async function call(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
    const result = (await client.callTool({ name, arguments: args }, undefined, LONG)) as CallToolResult
    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')
    return { text, isError: result.isError === true }
  }

  async function runningImage(): Promise<string> {
    return (await vm.inspect(`docker inspect openclaw --format '{{.Config.Image}}'`)).stdout.trim()
  }

  function legacy(args: string[]): string {
    return execFileSync('npx', ['-y', LEGACY_CLI, ...args], {
      env: { ...process.env, CLAWOPS_HOME: clawopsHome, HOME: path.dirname(clawopsHome) },
      encoding: 'utf-8',
      timeout: 1_200_000,
    })
  }

  beforeAll(async () => {
    if (!existsSync(ENTRY)) throw new Error(`${ENTRY} does not exist. Run \`pnpm build\` first.`)

    // The 2.x cache: the migration pulls the 2.x image, and only the 1.x one is new here.
    vm = await startVmTarget(TARGET_VERSION)
    clawopsHome = path.join(mkdtempSync(path.join(tmpdir(), 'clawops-e2e-legacy-')), '.clawops')
    mkdirSync(clawopsHome, { recursive: true })

    legacy([
      'init', '--non-interactive', '--provider', 'local', '--stack', STACK,
      '--host', vm.host, '--ssh-user', vm.user, '--ssh-port', String(vm.port), '--key-path', TEST_KEY_PATH,
    ])
    // 1.7.9 waits for the gateway from the operator's machine, at <host>:18789. This target
    // maps only SSH to the machine running the test, so that wait cannot succeed here even
    // though the gateway is healthy on the host. Everything else `up` does has already happened
    // by then, including recording the stack, so that one failure is tolerated, and the
    // deployment is checked from the host instead (the first test).
    try {
      legacy(['up', '--stack', STACK, '--openclaw-version', LEGACY_VERSION])
    } catch (err) {
      const said = String((err as { stdout?: string }).stdout ?? '') + String((err as { stderr?: string }).stderr ?? '')
      if (!/18789\/health did not become healthy/.test(said)) throw err
    }

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [ENTRY, 'mcp', 'serve'],
      env: { ...(process.env as Record<string, string>), HOME: path.dirname(clawopsHome), CLAWOPS_HOME: clawopsHome },
      stderr: 'inherit',
    })
    client = new Client({ name: 'clawops-e2e', version: '0.0.0' }, { capabilities: { elicitation: {} } })
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      elicitations.push(req.params.message)
      return answer === 'accept' ? { action: 'accept', content: { confirmed: true } } : { action: 'decline' }
    })
    await client.connect(transport)
  }, 1_800_000)

  afterAll(async () => {
    await client?.close()
    if (vm) await stopVmTarget(vm)
  })

  it('starts from the 1.x deployment 1.7.9 made', async () => {
    expect(await runningImage()).toBe(`ghcr.io/openclaw/openclaw:${LEGACY_VERSION}`)
    const health = await vm.inspect('curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://127.0.0.1:18789/health')
    expect(health.stdout.trim()).toBe('200')
    const status = await call('clawops_gateway_status', { stackName: STACK })
    expect(status.text).toContain(LEGACY_VERSION)
  })

  it('asks first, and a declined migration touches nothing', async () => {
    elicitations.length = 0
    answer = 'decline'
    const r = await call('clawops_migrate', { stackName: STACK })
    expect(elicitations).toHaveLength(1)
    expect(elicitations[0]).toContain(STACK)
    expect(elicitations[0]).toContain(TARGET_VERSION)
    expect(r.text).toMatch(/Cancelled/)
    expect(await runningImage()).toBe(`ghcr.io/openclaw/openclaw:${LEGACY_VERSION}`)
  })

  it('migrates to 2.x, in the background, and the gateway answers on the new runtime', async () => {
    const r = await call('clawops_migrate', { stackName: STACK, yes: true })
    expect(r.isError, r.text).toBe(false)

    // Past the synchronous window the tool returns a task to poll; inside it, the outcome.
    let outcome = r.text
    const taskId = /"taskId"\s*:\s*"([^"]+)"/.exec(r.text)?.[1]
    if (taskId) {
      const deadline = Date.now() + 1_200_000
      for (;;) {
        const t = await call('clawops_task_status', { taskId })
        if (/"status"\s*:\s*"(completed|failed)"/.test(t.text)) { outcome = t.text; break }
        if (Date.now() > deadline) throw new Error(`migration task ${taskId} did not finish: ${t.text}`)
        await new Promise((res) => setTimeout(res, 5_000))
      }
    }
    expect(outcome).not.toMatch(/"status"\s*:\s*"failed"/)

    expect(await runningImage()).toBe(`ghcr.io/openclaw/openclaw:${TARGET_VERSION}`)
    const probe = await vm.inspect('curl -s --max-time 5 http://127.0.0.1:18789/startupz')
    expect(probe.stdout).toMatch(/"status"\s*:\s*"started"/)

    // 1.7.9 left a systemd unit running the 1.x image. Past its RestartSec, the 2.x gateway
    // must still be the one running, under that unit.
    await new Promise((res) => setTimeout(res, 12_000))
    expect(await runningImage()).toBe(`ghcr.io/openclaw/openclaw:${TARGET_VERSION}`)
    expect((await vm.inspect('systemctl is-active openclaw')).stdout.trim()).toBe('active')
  }, 1_500_000)

  it('refuses to migrate a stack that is already on 2.x, and changes nothing', async () => {
    const before = await runningImage()
    const r = await call('clawops_migrate', { stackName: STACK, yes: true })
    expect(r.isError).toBe(false)
    expect(r.text).toMatch(/already/i)
    expect(r.text).toContain('gateway update')
    expect(await runningImage()).toBe(before)
  }, 300_000)
})
