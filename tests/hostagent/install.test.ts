// `clawops agent install` against a fake host that keeps openclaw.json as state, so a deny write
// changes what the next read returns. What is asserted is the order of effects on the host:
// nothing is written before the guardrail holds, and nothing is installed before the gateway is
// seen to hold the deny entries.

import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import type { SshSession, SshExecResult } from '../../src/transport/ssh.js'
import {
  installHostAgent, uninstallHostAgent, validateInstallOpts, plannedDenies, unitFile, unpackScript,
  nodeInstallScript, NODE_RUNTIME, AGENT_ROOT, type InstallOpts, type InstallDeps,
} from '../../src/hostagent/install.js'
import { CLAWOPS_TOOL_PATTERN } from '../../src/hostagent/guardrail.js'
import { peerTable } from '../../src/hostagent/peer-firewall.js'
import { makeUfwModule } from '../../src/harden/modules/ufw.js'

const TOKEN = 'tok-9f3a-REDACT-ME'

const OPTS: InstallOpts = {
  stack: 'prod', provider: 'gcp', agentId: 'ops', operators: ['telegram:12345'],
  allow: ['clawops_gateway_restart'], strict: false,
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- gateway configs are edited freely
function gateway(): Record<string, any> {
  return {
    agents: { entries: { main: { default: true }, ops: {}, helper: { tools: { deny: ['exec'] } } } },
    bindings: [{ agentId: 'ops', match: { channel: 'telegram', peer: { kind: 'direct', id: '12345' } } }],
    channels: { telegram: { dmPolicy: 'pairing' } },
    tools: { agentToAgent: { enabled: false }, sessions: { visibility: 'agent' } },
  }
}

interface Call { cmd: string; stdin?: string }

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- gateway configs are edited freely
function fakeHost(cfg: Record<string, any>, over: { persistDenies?: boolean; ufwActive?: boolean; answers?: boolean; restartOnWrite?: boolean; tailscale?: string; nftListing?: string } = {}) {
  const calls: Call[] = []
  const killed = new Set<string>()
  const ok = (stdout = ''): SshExecResult => ({ stdout, stderr: '', code: 0 })
  function respond(cmd: string): SshExecResult {
    if (cmd === 'uname -s') return ok('Linux\n')
    if (cmd.startsWith('tailscale status --json')) return ok(over.tailscale ?? '')
    if (cmd.includes('id -u clawops-peer')) return ok('998\n')
    if (cmd.includes('nft list table inet clawops_peer')) return ok(over.nftListing ?? peerListing(998))
    if (cmd === 'sudo -n true') return ok()
    if (/cat \/var\/lib\/clawops\/openclaw\/openclaw\.json/.test(cmd)) return ok(JSON.stringify(cfg))
    const set = /config set 'agents\.entries\.([^.]+)\.tools\.deny' '([^']+)' --strict-json/.exec(cmd)
    if (set) {
      if (over.persistDenies !== false) {
        const entry = cfg.agents.entries[set[1]!]
        // A restart under way kills the first write to each agent before it saves.
        if (over.restartOnWrite && !killed.has(set[1]!)) {
          killed.add(set[1]!)
          return { stdout: '', stderr: '', code: 137 }
        }
        entry.tools = { ...(entry.tools ?? {}), deny: JSON.parse(set[2]!) }
      }
      return ok()
    }
    if (cmd.includes('docker network inspect bridge')) return ok('172.17.0.1\n')
    if (cmd.includes('ufw status')) return ok(over.ufwActive ? 'Status: active\n' : 'Status: inactive\n')
    if (cmd.includes('curl -s -o /dev/null')) return ok(over.answers === false ? '000' : '401')
    return ok()
  }
  const session = {
    async exec(cmd: string) { calls.push({ cmd }); return respond(cmd) },
    async execWithInput(cmd: string, input: NodeJS.ReadableStream) {
      const chunks: Buffer[] = []
      for await (const c of input) chunks.push(Buffer.from(c as Buffer))
      calls.push({ cmd, stdin: Buffer.concat(chunks).toString() })
      return respond(cmd)
    },
  } as unknown as SshSession
  return { session, calls }
}

function deps(wired: { ok: true } | { ok: false; error: string } = { ok: true }): InstallDeps & { wiredWith: unknown[] } {
  const wiredWith: unknown[] = []
  return {
    wiredWith,
    payload: () => Buffer.from('payload'),
    token: () => TOKEN,
    wire: async (_s, _sig, url, token) => { wiredWith.push({ url, token }); return wired },
    startTimeoutMs: 50,
    pollMs: 5,
    now: () => new Date('2026-10-16T12:00:00Z'),
  }
}

const io = { step: () => {} }

/** What `nft list` prints for the table install loads, written out from that table. */
function peerListing(uid: number): string {
  return peerTable(uid).split('\n').filter((l) => !/^(#|table inet clawops_peer$|delete )/.test(l))
    .map((l) => l.replace(' counter ', ' counter packets 0 bytes 0 ')).join('\n')
}

const TAILNET_TAGGED = JSON.stringify({ BackendState: 'Running', Self: { Tags: ['tag:clawops-agent'] } })
const FLEET: InstallOpts = { ...OPTS, strict: true, servePeers: 'tag:clawops-agent', peers: ['us=us-gw'] }

/** A gateway on which no other agent can act in the container, so --strict passes. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- gateway configs are edited freely
function strictGateway(): Record<string, any> {
  const cfg = gateway()
  for (const id of ['main', 'helper']) cfg.agents.entries[id].tools = { ...cfg.agents.entries[id].tools, profile: 'messaging' }
  return cfg
}
const indexOf = (calls: Call[], re: RegExp) => calls.findIndex((c) => re.test(c.cmd))
const INSTALLS = /node-v22|bin\/node -e|systemctl|agent\.env|clawops-agent\.service/

describe('agent install flags', () => {
  it('refuses a bad agent id, a wildcard operator, an unallowable tool and a bad port', () => {
    const errors = validateInstallOpts({
      ...OPTS, agentId: 'ops; rm -rf /', operators: ['telegram:*', 'nocolon'],
      allow: ['clawops_destroy', 'clawops_up'], port: 80,
    })
    expect(errors.join('\n')).toMatch(/not an agent id/)
    expect(errors.join('\n')).toMatch(/wildcard/)
    expect(errors.join('\n')).toMatch(/"nocolon" is not in the form/)
    expect(errors.join('\n')).toMatch(/clawops_destroy would remove or move the host/)
    expect(errors.join('\n')).toMatch(/clawops_up cannot be allowed/)
    expect(errors.join('\n')).toMatch(/--port 80/)
    expect(validateInstallOpts(OPTS)).toEqual([])
  })
})

describe('agent install on the host', () => {
  it('refuses before writing anything when the guardrail would not hold', async () => {
    const cfg = gateway()
    cfg.bindings.push({ agentId: 'ops', match: { channel: 'telegram', peer: { kind: 'group', id: '-100' } } })
    const { session, calls } = fakeHost(cfg)
    const d = deps()
    const r = await installHostAgent(session, OPTS, io, undefined, d)
    expect(r).toMatchObject({ ok: false, stage: 'guardrail' })
    expect(r.ok ? '' : r.failures.join('\n')).toMatch(/group conversation/)
    expect(calls.filter((c) => /config set|sudo -n bash/.test(c.cmd))).toEqual([])
    expect(d.wiredWith).toEqual([])
  })

  it('counts the deny entries it is about to write, so an undenied agent is not a refusal', () => {
    const { config, added } = plannedDenies(gateway(), 'ops')
    expect(Object.keys(added).sort()).toEqual(['helper', 'main'])
    expect(added['helper']).toEqual(['exec', CLAWOPS_TOOL_PATTERN])
    expect(config['agents']).toMatchObject({ entries: { ops: {} } })
    expect(plannedDenies(config, 'ops').added).toEqual({})
  })

  it('refuses under --strict while another agent can act in the container, writing nothing', async () => {
    const { session, calls } = fakeHost(gateway())
    const r = await installHostAgent(session, { ...OPTS, strict: true }, io, undefined, deps())
    expect(r).toMatchObject({ ok: false, stage: 'guardrail' })
    expect(r.ok ? '' : r.failures.join('\n')).toMatch(/"main" can run commands/)
    expect(calls.filter((c) => /config set|sudo -n bash/.test(c.cmd))).toEqual([])
  })

  it('installs nothing when the gateway does not keep the deny entries', async () => {
    const { session, calls } = fakeHost(gateway(), { persistDenies: false })
    const r = await installHostAgent(session, OPTS, io, undefined, deps())
    expect(r).toMatchObject({ ok: false, stage: 'verify' })
    expect(r.ok ? '' : r.failures.join('\n')).toMatch(/"main" can call clawops/)
    expect(calls.filter((c) => INSTALLS.test(c.cmd))).toEqual([])
  })

  it('denies, installs, starts and wires, in that order, with the token only where it belongs', async () => {
    const cfg = gateway()
    const { session, calls } = fakeHost(cfg, { ufwActive: true })
    const d = deps()
    const r = await installHostAgent(session, OPTS, io, undefined, d)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.deniedAdded.sort()).toEqual(['helper', 'main'])
    expect(cfg.agents.entries.main.tools.deny).toEqual([CLAWOPS_TOOL_PATTERN])
    expect(r.reach.join('\n')).toMatch(/"main" can run commands/)
    expect(r.url).toBe('http://host.docker.internal:18790/')
    expect(d.wiredWith).toEqual([{ url: 'http://host.docker.internal:18790/', token: TOKEN }])

    const order = [/config set/, /node-v22/, /bin\/node -e/, /agent\.json/, /agent\.env/, /clawops-agent\.service\.new/, /ufw allow in on docker0/, /systemctl restart/, /curl -s/]
      .map((re) => indexOf(calls, re))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)

    // The token reaches the env file through stdin, and nothing else on the host.
    const withToken = calls.filter((c) => c.cmd.includes(TOKEN) || c.stdin?.includes(TOKEN))
    expect(withToken).toHaveLength(1)
    expect(withToken[0]!.cmd).toMatch(/agent\.env\.new && chmod 0600/)
    const agentJson = calls.find((c) => /agent\.json\.new/.test(c.cmd))!
    expect(JSON.parse(agentJson.stdin!)).toMatchObject({
      stack: 'prod', agentId: 'ops', allow: ['clawops_gateway_restart'], strict: false,
      listen: { address: '172.17.0.1', port: 18790 },
    })
    const unit = calls.find((c) => /clawops-agent\.service\.new/.test(c.cmd))!
    expect(unit.stdin).toContain('--bind 172.17.0.1')
  })

  it('waits out a gateway restart that killed a deny write, and writes it again', async () => {
    const cfg = gateway()
    const { session } = fakeHost(cfg, { restartOnWrite: true })
    const waited: number[] = []
    const r = await installHostAgent(session, OPTS, io, undefined, { ...deps(), waitGateway: async (_s, port) => { waited.push(port) } })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(waited).toEqual([18789, 18789])
    expect(cfg.agents.entries.main.tools.deny).toEqual([CLAWOPS_TOOL_PATTERN])
  })

  it('still refuses when the gateway never keeps the write', async () => {
    const { session, calls } = fakeHost(gateway(), { restartOnWrite: true, persistDenies: false })
    const r = await installHostAgent(session, OPTS, io, undefined, { ...deps(), waitGateway: async () => {} })
    expect(r).toMatchObject({ ok: false, stage: 'verify' })
    expect(calls.filter((c) => INSTALLS.test(c.cmd))).toEqual([])
  })

  it('stops the service and does not wire when it never answers', async () => {
    const { session, calls } = fakeHost(gateway(), { answers: false })
    const d = deps()
    const r = await installHostAgent(session, OPTS, io, undefined, d)
    expect(r).toMatchObject({ ok: false, stage: 'start' })
    expect(indexOf(calls, /systemctl disable --now clawops-agent/)).toBeGreaterThan(indexOf(calls, /systemctl restart/))
    expect(d.wiredWith).toEqual([])
  })

  it('stops the service when the gateway cannot reach it', async () => {
    const { session, calls } = fakeHost(gateway())
    const r = await installHostAgent(session, OPTS, io, undefined, deps({ ok: false, error: 'connect ECONNREFUSED' }))
    expect(r).toMatchObject({ ok: false, stage: 'wire' })
    expect(r.ok ? '' : r.failures[0]).toMatch(/ECONNREFUSED/)
    expect(indexOf(calls, /systemctl disable --now clawops-agent/)).toBeGreaterThan(0)
  })

  it('adds no firewall rule where ufw is not active', async () => {
    const { session, calls } = fakeHost(gateway(), { ufwActive: false })
    expect((await installHostAgent(session, OPTS, io, undefined, deps())).ok).toBe(true)
    expect(indexOf(calls, /ufw allow/)).toBe(-1)
  })
})

describe('agent install for a fleet member', () => {
  it('refuses an untagged host before writing anything', async () => {
    const { session, calls } = fakeHost(strictGateway(), { tailscale: JSON.stringify({ BackendState: 'Running', Self: {} }) })
    const r = await installHostAgent(session, FLEET, io, undefined, deps())
    expect(r).toEqual({ ok: false, stage: 'host', failures: [expect.stringMatching(/does not carry tag:clawops-agent/)] })
    expect(calls.some((c) => /config set|nft|useradd/.test(c.cmd) || INSTALLS.test(c.cmd))).toBe(false)
  })

  it('refuses a host that is not on the tailnet', async () => {
    const { session } = fakeHost(strictGateway(), { tailscale: '' })
    const r = await installHostAgent(session, FLEET, io, undefined, deps())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failures[0]).toMatch(/did not answer `tailscale status --json`/)
  })

  it('loads the table and checks it before the agent starts, and records the uid it lets through', async () => {
    const { session, calls } = fakeHost(strictGateway(), { tailscale: TAILNET_TAGGED })
    const r = await installHostAgent(session, FLEET, io, undefined, deps())
    expect(r.ok, JSON.stringify(r)).toBe(true)
    if (!r.ok) return
    expect(r.fleet).toEqual({ serves: 'tag:clawops-agent', peers: [{ stack: 'us', node: 'us-gw' }] })

    const order = [/id -u clawops-peer/, /peer-fw\.nft\.new/, /clawops-peer-fw\.service\.new/, /nft -f/, /nft list table/, /agent\.json\.new/, /systemctl restart clawops-agent/]
      .map((re) => indexOf(calls, re))
    expect(order.every((i) => i >= 0), JSON.stringify(order)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)

    const rules = calls.find((c) => /peer-fw\.nft\.new/.test(c.cmd))!
    expect(rules.stdin).toContain('meta skuid != 998')
    const agentJson = calls.find((c) => /agent\.json\.new/.test(c.cmd))!
    expect(JSON.parse(agentJson.stdin!).fleet).toEqual({ serves: 'tag:clawops-agent', peers: [{ stack: 'us', node: 'us-gw' }], peerUid: 998 })
  })

  it('does not start the agent when the loaded table is not the one it wrote', async () => {
    const { session, calls } = fakeHost(strictGateway(), { tailscale: TAILNET_TAGGED, nftListing: peerListing(1001) })
    const r = await installHostAgent(session, FLEET, io, undefined, deps())
    expect(r).toEqual({ ok: false, stage: 'install', failures: [expect.stringMatching(/Fleet firewall: .*out chain/)] })
    expect(calls.some((c) => /systemctl restart clawops-agent/.test(c.cmd))).toBe(false)
  })

  it('touches neither the tailnet nor nftables on a host outside a fleet', async () => {
    const { session, calls } = fakeHost(gateway())
    const r = await installHostAgent(session, OPTS, io, undefined, deps())
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.fleet).toBeUndefined()
    expect(calls.some((c) => /tailscale|nft|clawops-peer/.test(c.cmd))).toBe(false)
  })
})

describe('what install puts on the host', () => {
  it('has a unit that reads the token from its EnvironmentFile and writes only its state', () => {
    const unit = unitFile({ address: '172.17.0.1', port: 18790 })
    expect(unit).toContain('EnvironmentFile=/etc/clawops-agent/agent.env')
    expect(unit).toContain('--http 18790 --bind 172.17.0.1')
    expect(unit).toContain('ProtectSystem=strict')
    expect(unit).toContain('ReadWritePaths=/var/lib/clawops-agent')
    expect(unit).not.toMatch(/token/i)
  })

  it('verifies the Node runtime before extracting it', () => {
    const script = nodeInstallScript()
    expect(script).toContain(NODE_RUNTIME.sha256.x64)
    expect(script).toContain(NODE_RUNTIME.sha256.arm64)
    expect(script.indexOf('sha256sum -c')).toBeLessThan(script.indexOf('tar -xzf'))
    expect(script).toMatch(/^set -eu/)
    const syntax = spawnSync('/bin/bash', ['-n', '-c', script])
    expect(syntax.status).toBe(0)
  })

  it('refuses a download whose checksum does not match, extracting nothing', () => {
    // A well-formed tarball, so the only thing that can stop the extraction is the checksum.
    const scratch = mkdtempSync(path.join(tmpdir(), 'node-install-'))
    const root = path.join(scratch, 'opt')
    const bin = path.join(scratch, 'bin')
    mkdirSync(path.join(scratch, 'pkg', 'node-v0', 'bin'), { recursive: true })
    writeFileSync(path.join(scratch, 'pkg', 'node-v0', 'bin', 'node'), '#!/bin/sh\necho v0\n', { mode: 0o755 })
    const tgz = path.join(scratch, 'node.tgz')
    expect(spawnSync('tar', ['-czf', tgz, '-C', path.join(scratch, 'pkg'), 'node-v0']).status).toBe(0)
    mkdirSync(bin)
    writeFileSync(path.join(bin, 'curl'), `#!/bin/sh\nwhile [ "$1" != "-o" ]; do shift; done; cp ${tgz} "$2"\n`, { mode: 0o755 })
    // macOS has shasum, not sha256sum.
    if (spawnSync('sh', ['-c', 'command -v sha256sum']).status !== 0) {
      writeFileSync(path.join(bin, 'sha256sum'), '#!/bin/sh\nexec shasum -a 256 "$@"\n', { mode: 0o755 })
    }
    const script = nodeInstallScript().replaceAll(AGENT_ROOT, root)
    const run = spawnSync('/bin/bash', ['-c', script], { env: { ...process.env, PATH: `${bin}:${process.env['PATH']}` }, encoding: 'utf-8' })
    expect(run.stderr).toMatch(/checksum mismatch/)
    expect(run.status).toBe(4)
    expect(existsSync(path.join(root, 'node'))).toBe(false)
    rmSync(scratch, { recursive: true, force: true })
  })

  /** unpackScript, run with this machine's node against a scratch root. */
  function unpack(files: Record<string, string>, root: string) {
    const cmd = unpackScript().replace(`${AGENT_ROOT}/node/bin/node`, process.execPath).replace(/ \/opt\/clawops-agent$/, ` ${root}`)
    const payload = gzipSync(JSON.stringify(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, Buffer.from(v).toString('base64')]))))
    return spawnSync('/bin/bash', ['-c', cmd], { input: payload })
  }

  it('unpacks the bundle and spec/, replacing what was there', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'agent-root-'))
    mkdirSync(path.join(root, 'lib'))
    writeFileSync(path.join(root, 'lib', 'stale.mjs'), 'old')
    const r = unpack({ 'lib/host-agent.mjs': 'entry', 'lib/chunk-a.mjs': 'chunk', 'spec/mcp-tools.yaml': 'x: 1' }, root)
    expect(r.status).toBe(0)
    expect(readFileSync(path.join(root, 'lib', 'host-agent.mjs'), 'utf-8')).toBe('entry')
    expect(readFileSync(path.join(root, 'spec', 'mcp-tools.yaml'), 'utf-8')).toBe('x: 1')
    expect(existsSync(path.join(root, 'lib', 'stale.mjs'))).toBe(false)
    rmSync(root, { recursive: true, force: true })
  })

  it.each([
    ['climbs out of lib/', 'lib/../../evil'],
    ['is not under lib/ or spec/', 'evil/x'],
  ])('refuses a path that %s, writing nothing', (_why, bad) => {
    // A real payload around the bad entry, so the refusal has to come from the path check
    // and not from something else in the payload being missing.
    const parent = mkdtempSync(path.join(tmpdir(), 'agent-parent-'))
    const root = path.join(parent, 'root')
    mkdirSync(root)
    const r = unpack({ 'lib/host-agent.mjs': 'entry', [bad]: 'x', 'spec/mcp-tools.yaml': 'x: 1' }, root)
    expect(r.status).not.toBe(0)
    expect(existsSync(path.join(parent, 'evil'))).toBe(false)
    expect(existsSync(path.join(root, 'evil.new'))).toBe(false)
    expect(existsSync(path.join(root, 'lib'))).toBe(false)
    rmSync(parent, { recursive: true, force: true })
  })
})

describe('agent uninstall', () => {
  function host(agentJson: string, ufw: string, fleet = false) {
    const calls: string[] = []
    const session = {
      async exec(cmd: string): Promise<SshExecResult> {
        calls.push(cmd)
        if (cmd.includes('mcp show clawops')) return { stdout: 'clawops', stderr: '', code: 0 }
        if (cmd.includes('cat /etc/clawops-agent/agent.json')) return { stdout: agentJson, stderr: '', code: 0 }
        if (cmd.includes('ufw status')) return { stdout: ufw, stderr: '', code: 0 }
        if (cmd.includes('test -e /etc/systemd/system/clawops-peer-fw.service')) return { stdout: fleet ? 'yes\n' : 'no\n', stderr: '', code: 0 }
        return { stdout: '', stderr: '', code: 0 }
      },
    } as unknown as SshSession
    return { session, calls }
  }
  const JSON_WITH_LISTEN = JSON.stringify({ listen: { address: '172.17.0.1', port: 18790 } })

  it('unwires, removes the unit, files and firewall rule, and keeps the audit log', async () => {
    const { session, calls } = host(JSON_WITH_LISTEN, 'Status: active\n18790/tcp on docker0 ALLOW IN Anywhere # clawops host agent\n')
    const r = await uninstallHostAgent(session, { purge: false }, io)
    expect(r.failures).toEqual([])
    expect(calls.some((c) => c.includes('mcp unset clawops'))).toBe(true)
    expect(calls.some((c) => c.includes('ufw delete allow in on docker0 to 172.17.0.1 port 18790 proto tcp'))).toBe(true)
    const rm = calls.find((c) => c.includes('rm -rf'))!
    expect(rm).toContain('/opt/clawops-agent')
    expect(rm).not.toContain('/var/lib/clawops-agent')
    expect(r.kept.join('\n')).toMatch(/audit log/)
  })

  it('removes the fleet table and its unit where install loaded them', async () => {
    const { session, calls } = host(JSON_WITH_LISTEN, 'Status: inactive\n', true)
    const r = await uninstallHostAgent(session, { purge: false }, io)
    expect(r.failures).toEqual([])
    expect(r.removed.join('\n')).toMatch(/fleet firewall table/)
    expect(calls.some((c) => c.includes('nft delete table inet clawops_peer'))).toBe(true)
  })

  it('removes the state directory only with --purge', async () => {
    const { session, calls } = host(JSON_WITH_LISTEN, 'Status: inactive\n')
    await uninstallHostAgent(session, { purge: true }, io)
    expect(calls.find((c) => c.includes('rm -rf'))).toContain('/var/lib/clawops-agent')
    expect(calls.some((c) => c.includes('ufw delete'))).toBe(false)
  })
})

describe('harden keeps the host agent reachable', () => {
  async function applyUfw(agentJson: string): Promise<string> {
    const cmds: string[] = []
    const exec = async (cmd: string) => {
      cmds.push(cmd)
      if (cmd.includes('cat /etc/clawops-agent/agent.json')) return { stdout: agentJson, stderr: '', code: 0 }
      return { stdout: '', stderr: '', code: 0 }
    }
    await makeUfwModule().apply(exec as never)
    return cmds.find((c) => c.includes('ufw --force reset'))!
  }

  it('re-adds the bridge rule after its reset when a host agent is installed', async () => {
    const script = await applyUfw(JSON.stringify({ listen: { address: '172.17.0.1', port: 18790 } }))
    expect(script).toContain('ufw allow in on docker0 to 172.17.0.1 port 18790 proto tcp')
    expect(script.indexOf('ufw allow in on docker0')).toBeGreaterThan(script.indexOf('ufw --force reset'))
  })

  it('adds nothing for a host with no host agent', async () => {
    expect(await applyUfw('')).not.toContain('docker0')
  })
})
