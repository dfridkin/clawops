#!/usr/bin/env node
/**
 * Drive a real clawops MCP server over stdio and assert on what comes back.
 *
 *   pnpm build && pnpm verify:mcp
 *
 * Unit tests exercise handlers with the server mocked away. This exercises the server: the
 * handshake, the tool list a client actually receives, the annotations on it, the elicitation
 * a destructive tool is supposed to raise, and the rule that a stdio server writes protocol to
 * stdout and nothing else (R15).
 *
 * It exists because 2.0.2 shipped handlers that were fine and a server that died on import,
 * and because 2.1 nearly shipped a tool spec whose descriptions named tools that were never
 * served. Both are invisible from inside the unit suite.
 *
 * No cloud credentials, no network, nothing created: every call here is refused by design.
 *
 * It runs against a CLAWOPS_HOME of its own, holding one stack that was never deployed. A probe
 * that read the developer's real config would assert different things on every machine — and on
 * a machine with no config at all (CI) the tool refuses before it reaches the confirmation this
 * is here to check, which is exactly how the first version of this passed locally and failed in
 * CI.
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/*
 * Where the probe's throwaway config goes. A caller that cannot share a filesystem with the
 * server — the Docker check, where the config has to be mounted and CLAWOPS_HOME set on the
 * container rather than on the child process — passes the directory in and wires it up itself.
 */
const externalHome = process.env['CLAWOPS_PROBE_HOME']
const home = externalHome ?? mkdtempSync(path.join(tmpdir(), 'clawops-mcp-probe-'))
writeFileSync(
  path.join(home, 'config.json'),
  JSON.stringify({
    version: 1,
    defaults: { stack: 'probe', provider: 'aws' },
    stacks: {
      probe: {
        provider: 'aws',
        stateUrl: 's3://clawops-probe/clawops',
        region: 'us-east-1',
        credentialsRef: { source: 'cli-profile', profileName: 'probe' },
      },
    },
    ssh: { keyPath: path.join(home, 'id_ed25519'), knownHostsPath: path.join(home, 'known_hosts') },
  }),
)

const [, , cmd = 'node', ...rest] = process.argv
const args = rest.length > 0 ? rest : ['dist/cli.js', 'mcp', 'serve']
const proc = spawn(cmd, args, {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: externalHome ? process.env : { ...process.env, CLAWOPS_HOME: home },
})

let stdoutBuf = ''
let stderrBuf = ''
const pending = new Map()
const stdoutLines = []
const elicitations = []
let elicitAnswer = 'decline'

proc.stdout.on('data', (d) => {
  stdoutBuf += d.toString()
  let i
  while ((i = stdoutBuf.indexOf('\n')) >= 0) {
    const line = stdoutBuf.slice(0, i).trim()
    stdoutBuf = stdoutBuf.slice(i + 1)
    if (!line) continue
    stdoutLines.push(line)
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.method === 'elicitation/create' && msg.id !== undefined) {
      elicitations.push(msg.params)
      proc.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id: msg.id,
        result: elicitAnswer === 'decline' ? { action: 'decline' } : { action: 'accept', content: { confirmed: true } },
      }) + '\n')
      continue
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  }
})
proc.stderr.on('data', (d) => { stderrBuf += d.toString() })

let nextId = 1
function send(method, params, notify = false) {
  const id = notify ? undefined : nextId++
  const body = { jsonrpc: '2.0', method, ...(params ? { params } : {}), ...(notify ? {} : { id }) }
  proc.stdin.write(JSON.stringify(body) + '\n')
  if (notify) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 60000)
    pending.set(id, (m) => { clearTimeout(timer); resolve(m) })
  })
}

let failures = 0
function check(label, cond, detail = '') {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

const out = []
try {
  const init = await send('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: { elicitation: {} },
    clientInfo: { name: 'mcp-probe', version: '1' },
  })
  check('handshake', Boolean(init.result?.serverInfo),
    init.result?.serverInfo ? `${init.result.serverInfo.name} ${init.result.serverInfo.version}` : JSON.stringify(init).slice(0, 200))
  await send('notifications/initialized', {}, true)

  const list = await send('tools/list', {})
  const tools = list.result?.tools ?? []
  const names = tools.map((t) => t.name)
  check(`tools/list returns ${names.length} tools`, names.length === 19, names.length !== 19 ? names.join(',') : '')
  check('clawops_harden is served', names.includes('clawops_harden'))

  /*
   * The text a model reads when it chooses a tool. Held in spec/mcp-tools.yaml, generated into
   * nothing, and passed to registerTool not at all — so every client saw 19 tools with no
   * description, and Glama scored each one 1/5 for it. tools/list is the only place this shows.
   */
  const described = tools.filter((t) => typeof t.description === 'string' && t.description.length > 0)
  check(`every tool carries a description (${described.length}/${tools.length})`, described.length === tools.length,
    tools.filter((t) => !t.description).map((t) => t.name).join(', '))
  const routable = tools.filter((t) => /Use when/.test(t.description ?? ''))
  check('every description says when to use the tool (R3)', routable.length === tools.length,
    tools.filter((t) => !/Use when/.test(t.description ?? '')).map((t) => t.name).join(', '))

  const harden = tools.find((t) => t.name === 'clawops_harden')
  if (harden) {
    const props = Object.keys(harden.inputSchema?.properties ?? {})
    check('clawops_harden takes the tailscale flags', ['tailscale', 'tailscaleRevert', 'dryRun', 'options', 'yes'].every((k) => props.includes(k)), props.join(','))
    const a = harden.annotations ?? {}
    check('all four annotation hints set (R10)',
      ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'].every((k) => typeof a[k] === 'boolean'),
      JSON.stringify(a))
    check('marked destructive', a.destructiveHint === true)
  }

  const plan = tools.find((t) => t.name === 'clawops_plan')
  if (plan) {
    const props = Object.keys(plan.inputSchema?.properties ?? {})
    check('clawops_plan takes the network flags',
      ['sshCidr', 'gatewayCidr', 'publishGateway', 'privateOnly', 'openclawVersion'].every((k) => props.includes(k)), props.join(','))
    check('instanceType is no longer a closed enum', !plan.inputSchema?.properties?.instanceType?.enum)
  }

  // The guard added in this PR, over the wire rather than in a unit test.
  const both = await send('tools/call', { name: 'clawops_harden', arguments: { stackName: 'probe', tailscale: true, tailscaleRevert: true, yes: true } })
  const bothText = both.result?.content?.[0]?.text ?? JSON.stringify(both).slice(0, 200)
  check('refuses join and leave in one call', /opposite/.test(bothText), bothText.slice(0, 120))

  // A stack that does not exist must be a clean refusal, not a crash.
  const missing = await send('tools/call', { name: 'clawops_harden', arguments: { stackName: 'probe', dryRun: true } })
  const missingText = missing.result?.content?.[0]?.text ?? missing.error?.message ?? ''
  check('an undeployed stack is a clean refusal, not a crash',
    missing.error === undefined && missing.result?.isError === true && /no deployment to harden/i.test(missingText) && !/\n/.test(missingText),
    missingText.slice(0, 120))

  // R19: anything that changes a live host asks first, over the protocol.
  elicitations.length = 0
  elicitAnswer = 'decline'
  const declined = await send('tools/call', { name: 'clawops_harden', arguments: { stackName: 'probe' } })
  const declinedText = declined.result?.content?.[0]?.text ?? ''
  check('a host-changing call elicits confirmation (R19)', elicitations.length === 1, JSON.stringify(elicitations[0] ?? {}).slice(0, 120))
  check('declining stops it before anything runs', /cancelled/i.test(declinedText), declinedText.slice(0, 100))

  elicitations.length = 0
  await send('tools/call', { name: 'clawops_harden', arguments: { stackName: 'probe', dryRun: true } })
  check('a dry run asks nothing', elicitations.length === 0)

  elicitations.length = 0
  await send('tools/call', { name: 'clawops_harden', arguments: { stackName: 'probe', yes: true } })
  check('yes:true skips the prompt', elicitations.length === 0)

  out.push(...stdoutLines)
} catch (err) {
  check(`probe completed`, false, err.message)
}

// R15: a stdio server writes protocol and nothing else.
const nonJson = out.filter((l) => { try { JSON.parse(l); return false } catch { return true } })
check('stdout carries only protocol (R15)', nonJson.length === 0, nonJson.slice(0, 2).join(' | '))

proc.kill()
// The audit log goes to stderr (R15, R21); it is not an error, so it is not printed as one.
console.log(failures === 0 ? '\nMCP protocol checks passed' : `\n${failures} MCP protocol check(s) FAILED`)
if (failures > 0 && stderrBuf.trim()) {
  console.log(stderrBuf.trim().split('\n').slice(-5).join('\n'))
}
process.exit(failures === 0 ? 0 : 1)
