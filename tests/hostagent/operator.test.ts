// The operator's side of a handoff (ADR 0014 §3): `status` shows what the host agent asked for,
// and running the command it showed clears it.
//
// The shell lines run for real, against a directory standing in for the host agent's state
// directory and a `sudo` that records being asked. The quoting is three levels deep (JSON in
// printf in sudo's bash -c), so a fake that only matched strings would pass a broken line.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runCommand } from 'citty'
import type { SshSession } from '../../src/transport/ssh.js'
import { makeFakeContext } from '../helpers/context.js'

vi.mock('../../src/cli/context.js', () => ({ buildContext: vi.fn() }))
vi.mock('../../src/transport/pool.js', () => ({ acquireSession: vi.fn(), drainPool: vi.fn() }))
// The MCP restart's health gate polls the gateway; what is under test is what follows it.
vi.mock('../../src/plan/remote-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/plan/remote-config.js')>()),
  restartGateway: vi.fn().mockResolvedValue(undefined),
}))

import { HOST_AGENT_STATE_DIR } from '../../src/hostagent/config.js'
import {
  buildHandoff, clearedLine, parseHandoffs, HANDOFF_TTL_MS, SECRET_PLACEHOLDER,
} from '../../src/hostagent/handoff.js'
import {
  clearHostHandoffs, handoffBanner, readHostHandoffs,
} from '../../src/hostagent/operator.js'
import { enterHostAgentMode, exitHostAgentModeForTests } from '../../src/hostagent/mode.js'

let root: string
let stateDir: string
let sudoLog: string
let binDir: string

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'clawops-operator-'))
  stateDir = path.join(root, 'state')
  sudoLog = path.join(root, 'sudo.log')
  binDir = path.join(root, 'bin')
  mkdirSync(binDir)
  const sudo = path.join(binDir, 'sudo')
  writeFileSync(sudo, `#!/bin/sh\necho "$*" >> '${sudoLog}'\n[ "$1" = -n ] && shift\nexec "$@"\n`)
  chmodSync(sudo, 0o755)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  exitHostAgentModeForTests()
})

const handoffsFile = () => path.join(stateDir, 'handoffs.jsonl')

/** Run a command as the host would, with the state directory moved into the test's root. */
function hostShell(cmd: string): { stdout: string; stderr: string; code: number } {
  const local = cmd.split(HOST_AGENT_STATE_DIR).join(stateDir)
  const r = spawnSync('/bin/bash', ['-c', local], {
    encoding: 'utf-8',
    env: { ...process.env, PATH: `${binDir}:${process.env['PATH'] ?? ''}` },
  })
  return { stdout: r.stdout, stderr: r.stderr, code: r.status ?? 1 }
}

/** A session that runs handoff lines for real and answers everything else with `other`. */
function hostSession(other: (cmd: string) => { stdout: string; stderr: string; code: number } = () => ({ stdout: '', stderr: '', code: 0 })) {
  const commands: string[] = []
  const session = {
    async exec(cmd: string) {
      commands.push(cmd)
      return cmd.includes('handoffs.jsonl') ? hostShell(cmd) : other(cmd)
    },
    close() {},
  } as unknown as SshSession
  return { session, commands }
}

function agentRecords(...lines: string[]): void {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(handoffsFile(), lines.map((l) => l + '\n').join(''))
}

const sudoCalls = () => (existsSync(sudoLog) ? readFileSync(sudoLog, 'utf-8').trim().split('\n') : [])

describe('parseHandoffs', () => {
  const at = (msAgo: number, now: number) => new Date(now - msAgo)

  it('clears a request only with a later clear for the same command', () => {
    const now = Date.parse('2026-10-17T12:00:00Z')
    const restart = buildHandoff('clawops_gateway_restart', {}, 'prod', at(60_000, now))
    const update = buildHandoff('clawops_gateway_update', { version: '2026.9.2' }, 'prod', at(60_000, now))
    const raw = [
      JSON.stringify(restart),
      JSON.stringify(update),
      clearedLine(restart.command, at(30_000, now)),
    ].join('\n')
    expect(parseHandoffs(raw, now).map((h) => h.command)).toEqual([update.command])
  })

  it('keeps a request made after the clear: it is a new one', () => {
    const now = Date.parse('2026-10-17T12:00:00Z')
    const again = buildHandoff('clawops_gateway_restart', {}, 'prod', at(10_000, now))
    const raw = [clearedLine(again.command, at(30_000, now)), JSON.stringify(again)].join('\n')
    expect(parseHandoffs(raw, now)).toHaveLength(1)
  })

  it('drops lapsed requests and lines it cannot read', () => {
    const now = Date.parse('2026-10-17T12:00:00Z')
    const old = buildHandoff('clawops_gateway_restart', {}, 'prod', at(HANDOFF_TTL_MS + 1, now))
    const fresh = buildHandoff('clawops_gateway_restart', {}, 'prod', at(1, now))
    const raw = [JSON.stringify(old), '{not json', '42', 'null', '{"command":"x"}', JSON.stringify(fresh)].join('\n')
    expect(parseHandoffs(raw, now).map((h) => h.id)).toEqual([fresh.id])
  })
})

describe('on the host, through a real shell', () => {
  it('reads nothing, and asks no sudo, on a host without a host agent', async () => {
    const { session } = hostSession()
    expect(await readHostHandoffs(session)).toEqual({ ok: true, value: [] })
    await clearHostHandoffs(session, 'clawops_gateway_restart', {}, 'prod')
    expect(existsSync(stateDir)).toBe(false)
    expect(sudoCalls()).toEqual([])
  })

  it('reads an installed agent with no requests yet as none', async () => {
    mkdirSync(stateDir)
    const { session } = hostSession()
    expect(await readHostHandoffs(session)).toEqual({ ok: true, value: [] })
    await clearHostHandoffs(session, 'clawops_gateway_restart', {}, 'prod')
    // Clearing never creates the file: there was nothing to clear.
    expect(existsSync(handoffsFile())).toBe(false)
  })

  it('reads the requests with sudo, and a clear written there clears them', async () => {
    // A value with every character that could break one of the three quoting levels.
    const input = { key: 'agents.defaults.name', value: `it's "$HOME" \`x\` \\n; rm -rf /` }
    const request = buildHandoff('clawops_config_set', input, 'prod')
    agentRecords(JSON.stringify(request))
    const { session } = hostSession()

    const before = await readHostHandoffs(session)
    expect(before.ok && before.value.map((h) => h.command)).toEqual([request.command])
    expect(sudoCalls().length).toBeGreaterThan(0)

    await clearHostHandoffs(session, 'clawops_config_set', input, 'prod')
    expect(await readHostHandoffs(session)).toEqual({ ok: true, value: [] })
  })

  it('leaves other requests showing', async () => {
    const restart = buildHandoff('clawops_gateway_restart', {}, 'prod')
    const unset = buildHandoff('clawops_config_unset', { key: 'channels.slack' }, 'prod')
    agentRecords(JSON.stringify(restart), JSON.stringify(unset))
    const { session } = hostSession()
    await clearHostHandoffs(session, 'clawops_gateway_restart', {}, 'prod')
    const after = await readHostHandoffs(session)
    expect(after.ok && after.value.map((h) => h.command)).toEqual([unset.command])
  })

  it('reports a host it could not read, rather than none', async () => {
    agentRecords(JSON.stringify(buildHandoff('clawops_gateway_restart', {}, 'prod')))
    writeFileSync(path.join(binDir, 'sudo'), '#!/bin/sh\necho "sudo: a password is required" >&2\nexit 1\n')
    const { session } = hostSession()
    expect(await readHostHandoffs(session)).toEqual({ ok: false, error: 'sudo: a password is required' })
  })

  it('does nothing in host-agent mode: the agent reads its own file', async () => {
    agentRecords(JSON.stringify(buildHandoff('clawops_gateway_restart', {}, 'prod')))
    enterHostAgentMode({
      version: 1, stack: 'prod', provider: 'aws', agentId: 'ops', operators: ['telegram:1'],
      allow: [], strict: false, installedAt: '2026-10-17T00:00:00Z',
    })
    const { session, commands } = hostSession()
    await clearHostHandoffs(session, 'clawops_gateway_restart', {}, 'prod')
    expect(commands).toEqual([])
  })
})

describe('running the command a handoff shows clears it', () => {
  const SAMPLE_CONFIG = JSON.stringify({ gateway: { mode: 'local', port: 18789, auth: { mode: 'token' } } })

  /** What bash makes of the command, minus the leading `clawops`. */
  function words(command: string): string[] {
    const out = spawnSync('/bin/bash', ['-c', `set -- ${command.replace(/^clawops /, '')}; printf '%s\\0' "$@"`], { encoding: 'utf-8' })
    return out.stdout.split('\0').slice(0, -1)
  }

  async function runShown(command: string, other: Parameters<typeof hostSession>[0]) {
    const { buildContext } = await import('../../src/cli/context.js')
    const { acquireSession } = await import('../../src/transport/pool.js')
    vi.mocked(buildContext).mockReturnValue(makeFakeContext())
    const { session } = hostSession(other)
    vi.mocked(acquireSession).mockResolvedValue({ session, release: () => {} })
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const [file, ...rawArgs] = words(command)
    const { default: cmd } = await import(`../../src/cli/commands/${file}.ts`)
    try {
      await runCommand(cmd, { rawArgs })
    } finally {
      vi.mocked(process.stdout.write).mockRestore()
      vi.mocked(process.stderr.write).mockRestore()
    }
    return session
  }

  const gatewayHost = (cmd: string) => {
    if (cmd.includes('uname')) return { stdout: 'Linux', stderr: '', code: 0 }
    if (cmd.includes('PortBindings')) return { stdout: '{"18789/tcp":[{"HostIp":"127.0.0.1"}]}', stderr: '', code: 0 }
    if (cmd.includes('docker inspect')) return { stdout: 'ghcr.io/openclaw/openclaw:2026.9.2', stderr: '', code: 0 }
    if (cmd.includes('cat ')) return { stdout: SAMPLE_CONFIG, stderr: '', code: 0 }
    return { stdout: '', stderr: '', code: 0 }
  }

  it('config set with a secret: the operator types the value, the request still clears', async () => {
    // The stack name is the fake context's, so the CLI and the agent name the same stack.
    const request = buildHandoff('clawops_config_set', { key: 'gateway.auth.token', value: 'agent-saw-this' }, 'default')
    expect(request.command).toContain(SECRET_PLACEHOLDER)
    agentRecords(JSON.stringify(request))

    const typed = request.command.replace(SECRET_PLACEHOLDER, `'123:real token'`)
    const session = await runShown(typed, gatewayHost)
    expect(await readHostHandoffs(session)).toEqual({ ok: true, value: [] })
  })

  it('config unset with --restart', async () => {
    const request = buildHandoff('clawops_config_unset', { key: 'channels.slack', restart: true }, 'default')
    agentRecords(JSON.stringify(request))
    const session = await runShown(request.command, gatewayHost)
    expect(await readHostHandoffs(session)).toEqual({ ok: true, value: [] })
  })

  it('gateway restart', async () => {
    const request = buildHandoff('clawops_gateway_restart', {}, 'default')
    agentRecords(JSON.stringify(request))
    const session = await runShown(request.command, gatewayHost)
    expect(await readHostHandoffs(session)).toEqual({ ok: true, value: [] })
  })

  it('a different command leaves the request showing', async () => {
    const request = buildHandoff('clawops_config_unset', { key: 'channels.slack' }, 'default')
    agentRecords(JSON.stringify(request))
    const session = await runShown('clawops config unset channels.discord --stack default', gatewayHost)
    const after = await readHostHandoffs(session)
    expect(after.ok && after.value.map((h) => h.command)).toEqual([request.command])
  })
})

describe('the same request carried out through MCP clears it', () => {
  const SAMPLE_CONFIG = JSON.stringify({ gateway: { mode: 'local', port: 18789, auth: { mode: 'token' } } })
  const accepting = {
    server: {
      getClientCapabilities: () => ({ elicitation: {} }),
      elicitInput: vi.fn().mockResolvedValue({ action: 'accept', content: { confirmed: true } }),
    },
  } as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer

  async function wire() {
    const { buildContext } = await import('../../src/cli/context.js')
    const { acquireSession } = await import('../../src/transport/pool.js')
    vi.mocked(buildContext).mockReturnValue(makeFakeContext())
    const { session } = hostSession((cmd) =>
      cmd.includes('cat ') ? { stdout: SAMPLE_CONFIG, stderr: '', code: 0 } : { stdout: '', stderr: '', code: 0 })
    vi.mocked(acquireSession).mockResolvedValue({ session, release: () => {} })
    return session
  }

  it('clawops_config_set', async () => {
    const input = { stackName: 'default', key: 'gateway.auth.token', value: 'typed by the operator', restart: false }
    agentRecords(JSON.stringify(buildHandoff('clawops_config_set', { ...input, value: 'other' }, 'default')))
    const session = await wire()
    const { handleConfigSet } = await import('../../src/mcp/tools/cli/config.js')
    const r = await handleConfigSet(input, accepting)
    expect(r.isError).toBeFalsy()
    expect(await readHostHandoffs(session)).toEqual({ ok: true, value: [] })
  })

  it('clawops_gateway_restart', async () => {
    agentRecords(JSON.stringify(buildHandoff('clawops_gateway_restart', {}, 'default')))
    const session = await wire()
    const { handleGatewayRestart } = await import('../../src/mcp/tools/cli/gateway.js')
    const r = await handleGatewayRestart({ stackName: 'default' }, accepting)
    expect(r.isError).toBeFalsy()
    expect(await readHostHandoffs(session)).toEqual({ ok: true, value: [] })
  })
})

describe('handoffBanner', () => {
  it('names the stack and puts each command on its own line', () => {
    const a = buildHandoff('clawops_gateway_restart', {}, 'prod')
    const b = buildHandoff('clawops_config_set', { key: 'channels.telegram.botToken', value: 's' }, 'prod')
    const text = handoffBanner('prod', [a, b])
    expect(text).toContain('prod has 2 requests from its agent:')
    expect(text).toContain(`\n    ${a.command}\n`)
    expect(text).toContain(`\n    ${b.command}\n`)
    expect(text).toContain(`Replace ${SECRET_PLACEHOLDER}`)
    expect(handoffBanner('prod', [a])).toContain('prod has 1 request from its agent:')
    expect(handoffBanner('prod', [a])).not.toContain(SECRET_PLACEHOLDER)
  })
})
