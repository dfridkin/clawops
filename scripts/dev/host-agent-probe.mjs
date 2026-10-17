#!/usr/bin/env node
/**
 * Run the built host agent the way `clawops agent install` lays it out on a gateway host, and
 * call every tool it serves.
 *
 *   pnpm build && pnpm verify:host-agent
 *
 * The host agent ships as dist/host-agent/ plus spec/, with no node_modules: the cloud SDKs are
 * left out of the bundle (tsup.config.ts). That holds only while nothing host-agent mode reaches
 * imports one, and the unit suite cannot tell, because it runs from the source tree where every
 * package is installed. This runs the build from a directory with no node_modules above it and
 * fails if any tool's result says a package could not be found.
 *
 * The gateway is faked by two scripts on PATH: `cat` answers for openclaw.json with a
 * configuration the guardrail accepts, so calls get past it to their handlers, and `docker`
 * answers every command with nothing. What the tools report about that fake gateway is not
 * checked here; the e2e suite runs them against a real one.
 */

import { spawn } from 'node:child_process'
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const stage = mkdtempSync(path.join(tmpdir(), 'clawops-host-agent-'))
cpSync('dist/host-agent', path.join(stage, 'lib'), { recursive: true })
cpSync('spec', path.join(stage, 'spec'), { recursive: true })

const ALLOW = ['clawops_gateway_restart', 'clawops_config_set']
writeFileSync(path.join(stage, 'agent.json'), JSON.stringify({
  version: 1, stack: 'probe', provider: 'gcp', agentId: 'ops', operators: ['telegram:12345'],
  allow: ALLOW, installedAt: new Date().toISOString(),
}))

const GATEWAY_CONFIG = {
  agents: {
    entries: {
      main: { default: true, tools: { deny: ['clawops__*'] } },
      ops: {},
    },
  },
  bindings: [{ agentId: 'ops', match: { channel: 'telegram', peer: { kind: 'direct', id: '12345' } } }],
  channels: { telegram: { dmPolicy: 'pairing' } },
  tools: { agentToAgent: { enabled: false }, sessions: { visibility: 'agent' } },
}
const bin = path.join(stage, 'bin')
mkdirSync(bin)
writeFileSync(path.join(stage, 'openclaw.json'), JSON.stringify(GATEWAY_CONFIG))
writeFileSync(path.join(bin, 'cat'), [
  '#!/bin/sh',
  'case "$1" in *openclaw.json) exec /bin/cat ' + JSON.stringify(path.join(stage, 'openclaw.json')) + ' ;; esac',
  'exec /bin/cat "$@"',
].join('\n'))
writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\nexit 0\n')
chmodSync(path.join(bin, 'cat'), 0o755)
chmodSync(path.join(bin, 'docker'), 0o755)

const proc = spawn(process.execPath, ['lib/host-agent.mjs'], {
  cwd: stage,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    PATH: `${bin}:${process.env['PATH']}`,
    HOME: stage,
    CLAWOPS_HOME: path.join(stage, 'home'),
    CLAWOPS_AGENT_CONFIG: path.join(stage, 'agent.json'),
  },
})

let stdoutBuf = ''
let stderrBuf = ''
const pending = new Map()
const strayStdout = []
proc.stdout.on('data', (d) => {
  stdoutBuf += d.toString()
  let i
  while ((i = stdoutBuf.indexOf('\n')) >= 0) {
    const line = stdoutBuf.slice(0, i).trim()
    stdoutBuf = stdoutBuf.slice(i + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { strayStdout.push(line); continue }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  }
})
proc.stderr.on('data', (d) => { stderrBuf += d.toString() })

let nextId = 1
function request(method, params, timeoutMs = 30_000) {
  const id = nextId++
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)) }, timeoutMs)
    pending.set(id, (msg) => { clearTimeout(t); resolve(msg) })
  })
}

const failures = []
const check = (ok, what) => { if (!ok) failures.push(what) }
const MISSING = /Cannot find (package|module)|ERR_MODULE_NOT_FOUND/

/** Inputs that satisfy each tool's required fields; extra keys are stripped by its schema. */
const ARGS = { name: 'main', agent: 'main', key: 'gateway.port', value: '18789', taskId: 'none' }

try {
  const init = await request('initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'host-agent-probe', version: '1' },
  })
  check(init.result?.serverInfo?.name === 'clawops', `initialize failed: ${JSON.stringify(init.error ?? init.result)}`)
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')

  const list = await request('tools/list', {})
  const tools = (list.result?.tools ?? []).map((t) => t.name)
  check(tools.length === 12 + ALLOW.length, `expected ${12 + ALLOW.length} tools, got ${tools.length}: ${tools.join(', ')}`)

  for (const name of tools) {
    const res = await request('tools/call', { name, arguments: ARGS })
    const text = JSON.stringify(res)
    check(!MISSING.test(text), `${name} could not load a module: ${text.slice(0, 400)}`)
    check(!/only its operator/.test(text), `${name} was refused by the guardrail, so its handler never ran`)
    if (ALLOW.includes(name)) check(/clawops (gateway restart|config set)/.test(text), `${name} did not hand off: ${text.slice(0, 300)}`)
  }
  check(!MISSING.test(stderrBuf), `the server could not load a module: ${stderrBuf.slice(0, 400)}`)
  check(strayStdout.length === 0, `stdout carried non-protocol output: ${strayStdout.slice(0, 3).join(' | ')}`)
  console.log(`host-agent probe: ${tools.length} tools called from a directory with no node_modules`)
} catch (err) {
  failures.push(err instanceof Error ? err.message : String(err))
} finally {
  proc.kill()
  rmSync(stage, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`host-agent probe failed:\n- ${failures.join('\n- ')}\n\nserver stderr:\n${stderrBuf.slice(-2000)}`)
  process.exit(1)
}
