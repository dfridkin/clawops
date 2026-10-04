// The MCP tools that touch a host, driven the way an agent drives them.
//
// The handlers have unit tests against a FakeSshSession, and the CLI commands they share code
// with had, at most, a manual run on AWS. Neither proves the thing an agent depends on: that
// the built server, started over stdio by a real MCP client, does what it says to a real host.
// Every GCP deploy defect found in 2.0 passed against a fake host first.
//
// So this starts the published entry point (`dist/cli.js mcp serve`), connects the SDK's own
// Client with elicitation declared, and calls tools against the systemd target from
// ./vm-container.ts — the same host the bootstrap suite uses, with the same image cache. The
// stack is created and deployed through the tools too (clawops_init, clawops_up), so nothing
// here is set up behind the server's back except the SSH key, which has to be the fixture key
// the target trusts.
//
// Opt-in, like the bootstrap suite: `pnpm build && pnpm test:e2e:local`.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { copyFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ElicitRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { startVmTarget, stopVmTarget, TEST_KEY_PATH, type VmTarget } from './vm-container.js'

const FROM_VERSION = process.env['CLAWOPS_E2E_OPENCLAW_VERSION'] ?? '2026.9.2'
// A concrete release one step past the supported minimum. Pulled during the update test.
const TO_VERSION = process.env['CLAWOPS_E2E_UPDATE_TO'] ?? '2026.9.3'
const STATE_DIR = '/var/lib/clawops/openclaw'
const STACK = 'e2e-mcp'
const ENTRY = path.resolve(__dirname, '../../../dist/cli.js')
const LONG = { timeout: 1_200_000, resetTimeoutOnProgress: true }

const enabled = process.env['CLAWOPS_E2E_LOCAL'] === '1'

describe.skipIf(!enabled)('MCP tools against a real host, over stdio', () => {
  let vm: VmTarget
  let home: string
  let client: Client
  const elicitations: string[] = []
  let answer: 'accept' | 'decline' = 'decline'
  let archive: string

  async function call(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
    const result = (await client.callTool({ name, arguments: args }, undefined, LONG)) as CallToolResult
    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')
    return { text, isError: result.isError === true }
  }

  async function marker(): Promise<string> {
    return (await vm.inspect(`cat ${STATE_DIR}/e2e-marker 2>/dev/null || echo MISSING`)).stdout.trim()
  }

  async function writeMarker(value: string): Promise<void> {
    // Owned 1000:1000 like everything else in the state directory: the gateway runs as uid
    // 1000, and a root-owned file in there is the kind of thing a restore has to carry intact.
    await vm.inspect(`echo ${value} > ${STATE_DIR}/e2e-marker && chown 1000:1000 ${STATE_DIR}/e2e-marker`)
  }

  async function gatewayStarted(): Promise<boolean> {
    const probe = await vm.inspect('curl -s --max-time 5 http://127.0.0.1:18789/startupz')
    return /"status"\s*:\s*"started"/.test(probe.stdout)
  }

  async function runningImage(): Promise<string> {
    return (await vm.inspect(`docker inspect openclaw --format '{{.Config.Image}}'`)).stdout.trim()
  }

  /**
   * Past systemd's RestartSec. On a host that runs the gateway as a unit, replacing the
   * container behind systemd's back was undone about five seconds later — so a check made
   * straight after the call could pass on a result that was about to be reverted.
   */
  async function afterRestartWindow(): Promise<void> {
    await new Promise((res) => setTimeout(res, 12_000))
  }

  async function unitOwnsGateway(): Promise<boolean> {
    const active = await vm.inspect('systemctl is-active openclaw')
    return active.stdout.trim() === 'active'
  }

  async function portBindings(): Promise<string> {
    return (await vm.inspect(`docker inspect openclaw --format '{{json .HostConfig.PortBindings}}'`)).stdout.trim()
  }

  beforeAll(async () => {
    if (!existsSync(ENTRY)) throw new Error(`${ENTRY} does not exist. Run \`pnpm build\` first.`)

    vm = await startVmTarget(FROM_VERSION)

    // A home of its own: the server reads ~/.clawops and writes backups under it, and this must
    // never touch the developer's real config.
    home = mkdtempSync(path.join(tmpdir(), 'clawops-e2e-mcp-'))
    const clawopsHome = path.join(home, '.clawops')
    mkdirSync(clawopsHome, { recursive: true })
    // clawops_init reuses a key that is already there. It has to be the fixture key, because
    // that is the one the target's authorized_keys holds.
    copyFileSync(TEST_KEY_PATH, path.join(clawopsHome, 'id_ed25519'))
    copyFileSync(`${TEST_KEY_PATH}.pub`, path.join(clawopsHome, 'id_ed25519.pub'))
    chmodSync(path.join(clawopsHome, 'id_ed25519'), 0o600)

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [ENTRY, 'mcp', 'serve'],
      env: { ...(process.env as Record<string, string>), HOME: home, CLAWOPS_HOME: clawopsHome },
      stderr: 'inherit',
    })
    client = new Client({ name: 'clawops-e2e', version: '0.0.0' }, { capabilities: { elicitation: {} } })
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      elicitations.push(req.params.message)
      return answer === 'accept' ? { action: 'accept', content: { confirmed: true } } : { action: 'decline' }
    })
    await client.connect(transport)
  }, 300_000)

  afterAll(async () => {
    await client?.close()
    if (vm) await stopVmTarget(vm)
  })

  it('serves the tools this suite calls', async () => {
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name)
    for (const t of [
      'clawops_init', 'clawops_up', 'clawops_gateway_status', 'clawops_agents_list',
      'clawops_agents_logs', 'clawops_backup_create', 'clawops_backup_restore',
      'clawops_gateway_restart', 'clawops_gateway_update',
    ]) expect(names).toContain(t)
  })

  it('registers and deploys the stack through the tools', async () => {
    const init = await call('clawops_init', {
      provider: 'local', stackName: STACK, host: vm.host, sshUser: vm.user, sshPort: vm.port,
    })
    expect(init.isError, init.text).toBe(false)

    // clawops_up confirms through elicitation and takes no `yes`.
    answer = 'accept'
    const up = await call('clawops_up', { stackName: STACK, openclawVersion: FROM_VERSION })
    expect(up.isError, up.text).toBe(false)
    expect(await gatewayStarted()).toBe(true)
  }, 1_200_000)

  it('clawops_gateway_status reports the running container and its image', async () => {
    const status = await call('clawops_gateway_status', { stackName: STACK })
    expect(status.isError, status.text).toBe(false)
    expect(status.text).toContain('running')
    expect(status.text).toContain(`openclaw:${FROM_VERSION}`)
  })

  it('clawops_agents_list and clawops_agents_logs answer from the gateway', async () => {
    const list = await call('clawops_agents_list', { stackName: STACK })
    expect(list.isError, list.text).toBe(false)

    // A fresh gateway has its default agent and no activity yet. What matters is that the
    // query reaches OpenClaw and comes back as a page, not as a failure dressed as empty.
    const logs = await call('clawops_agents_logs', { stackName: STACK, name: 'main', limit: 5 })
    expect(logs.isError, logs.text).toBe(false)
    expect(JSON.parse(logs.text)).toMatchObject({ agent: 'main' })
  })

  it('clawops_backup_create writes an archive under ~/.clawops/backups by default', async () => {
    await writeMarker('before-backup')

    const created = await call('clawops_backup_create', { stackName: STACK })
    expect(created.isError, created.text).toBe(false)

    const dir = path.join(home, '.clawops', 'backups')
    const files = readdirSync(dir).filter((f) => f.endsWith('.tar.gz'))
    expect(files).toHaveLength(1)
    archive = path.join(dir, files[0]!)
    expect(statSync(archive).size).toBeGreaterThan(1024)
    // It holds the gateway's credentials; only its owner may read it.
    expect(statSync(archive).mode & 0o777).toBe(0o600)

    // The live state is untouched by taking a backup.
    expect(await marker()).toBe('before-backup')
  }, 600_000)

  it('clawops_backup_restore asks first, and a declined restore changes nothing', async () => {
    await writeMarker('after-backup')
    elicitations.length = 0
    answer = 'decline'

    const r = await call('clawops_backup_restore', { stackName: STACK, file: archive, activate: true })
    expect(elicitations).toHaveLength(1)
    expect(elicitations[0]).toContain(STACK)
    expect(r.text).toMatch(/Cancelled/)
    expect(await marker()).toBe('after-backup')
    const staged = await vm.inspect(`ls -d ${STATE_DIR}.* 2>/dev/null | wc -l`)
    expect(staged.stdout.trim()).toBe('0')
  })

  it('clawops_backup_restore without activate stages beside the live state and touches nothing live', async () => {
    elicitations.length = 0
    answer = 'accept'

    const r = await call('clawops_backup_restore', { stackName: STACK, file: archive })
    expect(r.isError, r.text).toBe(false)
    expect(elicitations).toHaveLength(1)
    expect(await marker()).toBe('after-backup')
    expect(await gatewayStarted()).toBe(true)
  }, 600_000)

  it('clawops_backup_restore with activate puts the backup into service and keeps what it replaced', async () => {
    const r = await call('clawops_backup_restore', { stackName: STACK, file: archive, activate: true, yes: true })
    expect(r.isError, r.text).toBe(false)

    // The state is the backup's, the gateway answers on it, and the state it replaced is kept.
    expect(await marker()).toBe('before-backup')
    expect(await gatewayStarted()).toBe(true)
    const kept = await vm.inspect(`cat ${STATE_DIR}.pre-restore-*/e2e-marker`)
    expect(kept.stdout.trim()).toBe('after-backup')

    // Still owned by the uid the container runs as, or the gateway exits on its own WAL.
    const owners = await vm.inspect(`find ${STATE_DIR} -printf '%U\\n' | sort -u | tr '\\n' ' '`)
    expect(owners.stdout.trim()).toBe('1000')
  }, 900_000)

  it('clawops_gateway_restart keeps the version and the publish scope', async () => {
    const image = await runningImage()
    const bindings = await portBindings()

    const r = await call('clawops_gateway_restart', { stackName: STACK })
    // gateway_restart takes no yes; with the client accepting, it runs.
    expect(r.isError, r.text).toBe(false)
    expect(await runningImage()).toBe(image)
    expect(await portBindings()).toBe(bindings)
    expect(await gatewayStarted()).toBe(true)

    await afterRestartWindow()
    expect(await unitOwnsGateway()).toBe(true)
    expect(await runningImage()).toBe(image)
    expect(await gatewayStarted()).toBe(true)
  }, 600_000)

  it('clawops_gateway_update refuses a moving tag before touching the host', async () => {
    const before = await runningImage()
    const r = await call('clawops_gateway_update', { stackName: STACK, version: 'latest', yes: true })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/moving tag/)
    expect(await runningImage()).toBe(before)
  })

  it('clawops_gateway_update asks first, naming both versions', async () => {
    elicitations.length = 0
    answer = 'decline'
    const r = await call('clawops_gateway_update', { stackName: STACK, version: TO_VERSION })
    expect(elicitations).toHaveLength(1)
    expect(elicitations[0]).toContain(FROM_VERSION)
    expect(elicitations[0]).toContain(TO_VERSION)
    expect(r.text).toMatch(/Cancelled/)
    expect(await runningImage()).toContain(FROM_VERSION)
  })

  it('clawops_gateway_update moves the gateway to the new version, and it answers', async () => {
    const bindings = await portBindings()
    const r = await call('clawops_gateway_update', { stackName: STACK, version: TO_VERSION, yes: true })
    expect(r.isError, r.text).toBe(false)

    expect(await runningImage()).toBe(`ghcr.io/openclaw/openclaw:${TO_VERSION}`)
    expect(await portBindings()).toBe(bindings)
    expect(await gatewayStarted()).toBe(true)
    // The state survived the update.
    expect(await marker()).toBe('before-backup')

    // ...and systemd did not put the old version back.
    await afterRestartWindow()
    expect(await unitOwnsGateway()).toBe(true)
    expect(await runningImage()).toBe(`ghcr.io/openclaw/openclaw:${TO_VERSION}`)
    expect(await gatewayStarted()).toBe(true)

    const status = await call('clawops_gateway_status', { stackName: STACK })
    expect(status.text).toContain(`openclaw:${TO_VERSION}`)
  }, 1_200_000)
})
