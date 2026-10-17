// `clawops agent install` and `agent uninstall` — ADR 0014 §1, run from the operator's machine.
//
// What lands on the gateway host:
//
//   /opt/clawops-agent/node/        a pinned Node runtime, checksum-verified on the host
//   /opt/clawops-agent/lib/         dist/host-agent/ from the operator's own clawops
//   /opt/clawops-agent/spec/        spec/, which the read tools load at runtime
//   /etc/clawops-agent/agent.json   what the agent manages (config.ts); no secrets
//   /etc/clawops-agent/agent.env    the bearer token, root-only
//   /var/lib/clawops-agent/         CLAWOPS_HOME: audit log, handoffs, tasks
//   clawops-agent.service           the server, on the Docker bridge address only
//
// Nothing is installed from npm on the host. The bundle is the operator's clawops at the
// operator's version, so what the agent runs is what the operator reviewed.
//
// Order matters. The guardrail is checked against the configuration as it will be, before
// anything is written; the deny entries are then written and the guardrail checked again
// against what the gateway actually holds; only then is anything installed. A refusal at
// either check leaves the host as it was, apart from deny entries, which only ever remove
// clawops from agents that should not have it.
//
// The unit runs as root. Reading the gateway's state directory (owned by the container's
// uid), `ufw status` and `sshd -T` all need it, and the Docker access every read tool needs is
// root-equivalent anyway. It is contained by its tool surface and by the systemd sandbox below,
// not by a user that would only look less privileged.

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import type { SshSession, SshExecResult } from '../transport/ssh.js'
import { sudoWrap, shellQuote, execPrivileged } from '../transport/privileged.js'
import { readRemoteConfig } from '../plan/remote-config.js'
import { resolveSpecDir } from '../spec-path.js'
import { checkGuardrail, containerReach, CLAWOPS_TOOL_PATTERN, deniesClawops } from './guardrail.js'
import { HANDOFF_TOOLS, notAllowableReason } from './tools.js'
import { HOST_AGENT_CONFIG_PATH, HOST_AGENT_STATE_DIR, type HostAgentConfig } from './config.js'
import { MCP_HTTP_PORT } from '../mcp/server.js'
import { GATEWAY_PORT } from '../openclaw/run-flags.js'
import { PUBLISH_INSPECT_CMD, publishedGatewayPort } from '../openclaw/runtime.js'
import { ufwAllowRule, ufwDeleteRule, listenFrom, HOST_AGENT_UFW_COMMENT } from './firewall.js'

export const AGENT_ROOT = '/opt/clawops-agent'
export const AGENT_ETC = path.posix.dirname(HOST_AGENT_CONFIG_PATH)
export const AGENT_ENV_PATH = `${AGENT_ETC}/agent.env`
export const UNIT_NAME = 'clawops-agent.service'
export const UNIT_PATH = `/etc/systemd/system/${UNIT_NAME}`

/**
 * The Node runtime the host agent runs on. The checksums are from nodejs.org's SHASUMS256.txt
 * for this release, whose signature was verified against the Node release keys
 * (github.com/nodejs/release-keys) on 2026-10-16. The host checks them before extracting.
 */
export const NODE_RUNTIME = {
  version: 'v22.23.3',
  sha256: {
    x64: '1084aa36196bba4c3a5e69a1ee388a6e4ff729dad09445fbcd434b28fe3c24af',
    arm64: '5ced2d48d1d7198739b7f86804de0171aefb6823b684b12341d3321afc3cb0b2',
  },
} as const

export interface InstallOpts {
  stack: string
  provider: string
  agentId: string
  operators: string[]
  allow: string[]
  strict: boolean
  port?: number
}

export interface InstallIo {
  step(message: string): void
}

export type InstallResult =
  | { ok: true; deniedAdded: string[]; reach: string[]; url: string; afterWire: string[] }
  | { ok: false; stage: 'input' | 'host' | 'guardrail' | 'verify' | 'install' | 'start' | 'wire'; failures: string[] }

// ── Pure parts ───────────────────────────────────────────────────────────────

const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

/** Everything wrong with the flags, before anything touches the host. */
export function validateInstallOpts(opts: InstallOpts): string[] {
  const errors: string[] = []
  if (!AGENT_ID_RE.test(opts.agentId)) {
    errors.push(`--agent "${opts.agentId}" is not an agent id (letters, digits, "_" and "-").`)
  }
  if (opts.operators.length === 0) {
    errors.push('--operator is required: the <channel>:<peer-id> of the person this agent answers.')
  }
  for (const op of opts.operators) {
    const i = op.indexOf(':')
    if (i <= 0 || i === op.length - 1) errors.push(`--operator "${op}" is not in the form <channel>:<peer-id>.`)
    else if (op.slice(i + 1).includes('*')) errors.push(`--operator "${op}" names a wildcard, not one person.`)
  }
  for (const tool of opts.allow) {
    if (!HANDOFF_TOOLS.includes(tool)) errors.push(notAllowableReason(tool))
  }
  if (opts.port !== undefined && (!Number.isInteger(opts.port) || opts.port < 1024 || opts.port > 65535)) {
    errors.push(`--port ${opts.port} is not a port between 1024 and 65535.`)
  }
  return errors
}

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined

/**
 * The deny entry each other agent needs (SP-13), and the configuration once they are written.
 * An agent whose deny already covers every clawops name is left alone.
 */
export function plannedDenies(config: Obj, agentId: string): { config: Obj; added: Record<string, string[]> } {
  const next = structuredClone(config)
  const entries = obj(obj(next['agents'])?.['entries']) ?? {}
  const added: Record<string, string[]> = {}
  for (const [id, raw] of Object.entries(entries)) {
    if (id === agentId) continue
    const entry = obj(raw)
    if (!entry) continue
    const tools = obj(entry['tools']) ?? {}
    const deny = Array.isArray(tools['deny']) ? (tools['deny'] as unknown[]).filter((p): p is string => typeof p === 'string') : []
    if (deniesClawops(deny)) continue
    const nextDeny = [...deny, CLAWOPS_TOOL_PATTERN]
    tools['deny'] = nextDeny
    entry['tools'] = tools
    added[id] = nextDeny
  }
  return { config: next, added }
}

/** Downloads, verifies and unpacks the Node runtime, unless the pinned version is already there. */
export function nodeInstallScript(): string {
  const { version, sha256 } = NODE_RUNTIME
  const dir = `${AGENT_ROOT}/node`
  return [
    'set -eu',
    'case "$(uname -m)" in',
    `  x86_64|amd64) A=x64; SUM=${sha256.x64} ;;`,
    `  aarch64|arm64) A=arm64; SUM=${sha256.arm64} ;;`,
    '  *) echo "unsupported architecture $(uname -m)" >&2; exit 3 ;;',
    'esac',
    `if [ -x ${dir}/bin/node ] && [ "$(${dir}/bin/node --version)" = ${version} ]; then exit 0; fi`,
    'T=$(mktemp -d); trap \'rm -rf "$T"\' EXIT',
    `curl -fsSL --proto '=https' -o "$T/node.tgz" "https://nodejs.org/dist/${version}/node-${version}-linux-$A.tar.gz"`,
    'echo "$SUM  $T/node.tgz" | sha256sum -c - >/dev/null || { echo "Node runtime checksum mismatch" >&2; exit 4; }',
    `mkdir -p ${AGENT_ROOT} && rm -rf ${dir}.new && mkdir ${dir}.new`,
    `tar -xzf "$T/node.tgz" -C ${dir}.new --strip-components=1`,
    `rm -rf ${dir} && mv ${dir}.new ${dir}`,
  ].join('\n')
}

/**
 * Unpacks the bundle on the host with the Node runtime just installed. The payload is gzipped
 * JSON of `{ path: base64 }`, so no archiver has to agree between the operator's machine (often
 * macOS, whose tar adds extended attributes) and the host.
 */
export function unpackScript(): string {
  const js = [
    "const z=require('zlib'),fs=require('fs'),p=require('path');",
    "const root=process.argv[1];const chunks=[];",
    "process.stdin.on('data',c=>chunks.push(c)).on('end',()=>{",
    "const files=JSON.parse(z.gunzipSync(Buffer.concat(chunks)).toString());",
    "for(const d of ['lib','spec'])fs.rmSync(p.join(root,d+'.new'),{recursive:true,force:true});",
    "for(const [f,b] of Object.entries(files)){const [top,...rest]=f.split('/');",
    "if(!['lib','spec'].includes(top)||rest.includes('..'))throw new Error('bad path '+f);",
    "const out=p.join(root,top+'.new',...rest);fs.mkdirSync(p.dirname(out),{recursive:true});",
    "fs.writeFileSync(out,Buffer.from(b,'base64'),{mode:0o644})}",
    "for(const d of ['lib','spec']){fs.rmSync(p.join(root,d),{recursive:true,force:true});",
    "fs.renameSync(p.join(root,d+'.new'),p.join(root,d))}",
    "console.log(Object.keys(files).length)});",
  ].join('')
  return `${AGENT_ROOT}/node/bin/node -e ${shellQuote(js)} ${AGENT_ROOT}`
}

/** The systemd unit. The token comes from the EnvironmentFile, never the command line. */
export function unitFile(listen: { address: string; port: number }): string {
  return [
    '# Written by `clawops agent install` (ADR 0014). Remove with `clawops agent uninstall`.',
    '[Unit]',
    'Description=clawops host agent',
    'After=docker.service',
    'Wants=docker.service',
    '',
    '[Service]',
    `EnvironmentFile=${AGENT_ENV_PATH}`,
    `Environment=CLAWOPS_HOME=${HOST_AGENT_STATE_DIR}`,
    `Environment=CLAWOPS_AGENT_CONFIG=${HOST_AGENT_CONFIG_PATH}`,
    `ExecStart=${AGENT_ROOT}/node/bin/node ${AGENT_ROOT}/lib/host-agent.mjs --http ${listen.port} --bind ${listen.address}`,
    'Restart=on-failure',
    'RestartSec=5',
    // Read-only everywhere but its own state. The read tools run docker, systemctl, ufw and
    // sshd, all of which only read here, and the Docker socket is reachable under ProtectSystem.
    'ProtectSystem=strict',
    `ReadWritePaths=${HOST_AGENT_STATE_DIR}`,
    'ProtectHome=read-only',
    'PrivateTmp=true',
    'NoNewPrivileges=true',
    'ProtectKernelTunables=true',
    'ProtectKernelModules=true',
    'ProtectControlGroups=true',
    'RestrictSUIDSGID=true',
    'LockPersonality=true',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n')
}

/** Where the built host agent is, beside this module in an installed package or under dist/. */
export function resolveHostAgentBundle(startUrl: string = import.meta.url): string {
  let dir = path.dirname(fileURLToPath(startUrl))
  const { root } = path.parse(dir)
  while (true) {
    for (const candidate of [path.join(dir, 'host-agent'), path.join(dir, 'dist', 'host-agent')]) {
      if (existsSync(path.join(candidate, 'host-agent.mjs'))) return candidate
    }
    if (dir === root) break
    dir = path.dirname(dir)
  }
  throw new Error(
    'Cannot find the built host agent (dist/host-agent/host-agent.mjs). In a source checkout, ' +
      'run `pnpm build` first; in an installed package it ships with clawops.',
  )
}

function collect(dir: string, prefix: string, out: Record<string, string>): void {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    const rel = `${prefix}/${name}`
    if (statSync(full).isDirectory()) collect(full, rel, out)
    else out[rel] = readFileSync(full).toString('base64')
  }
}

/** The bundle and spec/, as the payload unpackScript expects. */
export function bundlePayload(bundleDir = resolveHostAgentBundle(), specDir = resolveSpecDir()): Buffer {
  const files: Record<string, string> = {}
  collect(bundleDir, 'lib', files)
  collect(specDir, 'spec', files)
  return gzipSync(JSON.stringify(files))
}

// ── Talking to the host ──────────────────────────────────────────────────────

function asRoot(session: SshSession, script: string, signal?: AbortSignal, input?: Buffer | string): Promise<SshExecResult> {
  const cmd = sudoWrap(script)
  return input === undefined
    ? session.exec(cmd, signal)
    : session.execWithInput(cmd, Readable.from([typeof input === 'string' ? Buffer.from(input) : input]), signal)
}

const OC = 'docker exec openclaw openclaw'

function errText(r: SshExecResult): string {
  return (r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`).slice(0, 2000)
}

/** Writes a file as root with the given mode, from stdin, so its contents never reach a command line. */
async function writeRootFile(session: SshSession, file: string, mode: string, contents: string, signal?: AbortSignal): Promise<SshExecResult> {
  const dir = path.posix.dirname(file)
  return asRoot(session, `umask 077 && mkdir -p ${dir} && cat > ${file}.new && chmod ${mode} ${file}.new && mv ${file}.new ${file}`, signal, contents)
}

export interface InstallDeps {
  /** The gzipped bundle; tests pass a small one. */
  payload?: () => Buffer
  /** Token generator; tests pass a fixed one. */
  token?: () => string
  /** The gateway wiring step; tests replace it. Defaults to `openclaw mcp add` via mcp-wire. */
  wire?: (session: SshSession, signal: AbortSignal | undefined, url: string, token: string) => Promise<{ ok: true } | { ok: false; error: string }>
  /** How long to wait for the server to answer. */
  startTimeoutMs?: number
  /** Between probes of the server. */
  pollMs?: number
  /** Waits for the gateway after a write it answered by restarting. */
  waitGateway?: (session: SshSession, port: number, signal?: AbortSignal) => Promise<void>
  now?: () => Date
}

async function defaultWire(session: SshSession, signal: AbortSignal | undefined, url: string, token: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const { wireGatewayMcp } = await import('../cli/mcp-wire.js')
  const r = await wireGatewayMcp(session, signal ?? new AbortController().signal, { url, token, rewire: true })
  if (r.status === 'wired') return { ok: true }
  if (r.status === 'unsupported') return { ok: false, error: 'This gateway has no `openclaw mcp add`; upgrade it to 2026.7.1-2 or later.' }
  if (r.status === 'probe-failed') return { ok: false, error: r.error }
  return { ok: false, error: 'The gateway kept an existing clawops entry.' }
}

/** Exit codes of a `docker exec` killed because its container stopped under it. */
export const KILLED_BY_RESTART = new Set([137, 143])

async function defaultWaitGateway(session: SshSession, port: number, signal?: AbortSignal): Promise<void> {
  const { waitForGateway } = await import('../openclaw/ready.js')
  await waitForGateway(session, { port, timeoutMs: 180_000, intervalMs: 3_000, signal })
}

/**
 * A gateway config write, retried across a gateway restart.
 *
 * Some keys make the gateway restart itself: writing a channel's settings, measured on 2026.9.2,
 * makes the process exit about two seconds later and systemd recreate the container, which is
 * down for around ten seconds. A `docker exec` running in that window is killed with the
 * container (137 or 143) and its write is lost. That window can be open when install starts,
 * after the operator's own last change. So wait for the gateway, then run the write again: it
 * sets a value, so running it twice is harmless. The caller reads the configuration back and
 * checks it either way.
 */
async function gatewayWrite(
  session: SshSession,
  cmd: string,
  gatewayPort: number,
  signal: AbortSignal | undefined,
  deps: InstallDeps,
): Promise<SshExecResult> {
  let r = await execPrivileged(session, cmd, signal)
  for (let attempt = 0; attempt < 3 && KILLED_BY_RESTART.has(r.code); attempt++) {
    await (deps.waitGateway ?? defaultWaitGateway)(session, gatewayPort, signal)
    r = await execPrivileged(session, cmd, signal)
  }
  return r
}

export async function installHostAgent(
  session: SshSession,
  opts: InstallOpts,
  io: InstallIo,
  signal?: AbortSignal,
  deps: InstallDeps = {},
): Promise<InstallResult> {
  const inputErrors = validateInstallOpts(opts)
  if (inputErrors.length > 0) return { ok: false, stage: 'input', failures: inputErrors }
  const port = opts.port ?? MCP_HTTP_PORT

  io.step('Checking the host')
  const os = await session.exec('uname -s', signal)
  if (os.stdout.trim() !== 'Linux') {
    return { ok: false, stage: 'host', failures: [`A host agent runs on a Linux gateway host; this one is ${os.stdout.trim() || 'unknown'}.`] }
  }
  const sudo = await session.exec('sudo -n true', signal)
  if (sudo.code !== 0) {
    return { ok: false, stage: 'host', failures: ['Installing needs passwordless sudo for the SSH user on the host.'] }
  }

  // 1. The guardrail, against the configuration as install would leave it.
  io.step('Checking that only the operator can reach the agent')
  const before = await readRemoteConfig(session, signal)
  const planned = plannedDenies(before, opts.agentId)
  const subject = { agentId: opts.agentId, operators: opts.operators, strict: opts.strict }
  const plannedCheck = checkGuardrail(planned.config, subject)
  if (!plannedCheck.ok) return { ok: false, stage: 'guardrail', failures: plannedCheck.failures }

  // 2. Deny clawops to every other agent, then check what the gateway actually holds.
  const deniedAdded = Object.keys(planned.added)
  // Where the host reaches the gateway, for waiting on it after a restart: the published port,
  // read from the container as the ufw module does, not gateway.port inside it.
  const published = await execPrivileged(session, `${PUBLISH_INSPECT_CMD} 2>/dev/null || true`, signal)
  const gatewayPort = publishedGatewayPort(published.stdout) ?? GATEWAY_PORT
  for (const [id, deny] of Object.entries(planned.added)) {
    io.step(`Denying clawops to agent "${id}"`)
    const r = await gatewayWrite(
      session,
      `${OC} config set ${shellQuote(`agents.entries.${id}.tools.deny`)} ${shellQuote(JSON.stringify(deny))} --strict-json`,
      gatewayPort,
      signal,
      deps,
    )
    if (r.code !== 0) return { ok: false, stage: 'verify', failures: [`Could not deny clawops to "${id}": ${errText(r)}`] }
  }
  const after = await readRemoteConfig(session, signal)
  const actual = checkGuardrail(after, subject)
  if (!actual.ok) return { ok: false, stage: 'verify', failures: actual.failures }

  // 3. The runtime and the bundle.
  io.step(`Installing the Node runtime (${NODE_RUNTIME.version}, checksum-verified)`)
  const node = await asRoot(session, nodeInstallScript(), signal)
  if (node.code !== 0) return { ok: false, stage: 'install', failures: [`Node runtime: ${errText(node)}`] }

  io.step('Copying the host agent')
  const unpack = await asRoot(session, unpackScript(), signal, (deps.payload ?? (() => bundlePayload()))())
  if (unpack.code !== 0) return { ok: false, stage: 'install', failures: [`Host agent files: ${errText(unpack)}`] }

  // 4. Configuration, token and unit.
  const bridge = await execPrivileged(session, "docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}'", signal)
  const address = bridge.stdout.trim()
  if (bridge.code !== 0 || !/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) {
    return { ok: false, stage: 'install', failures: [`Could not read the Docker bridge address: ${errText(bridge)}`] }
  }
  const listen = { address, port }
  const config: HostAgentConfig = {
    version: 1,
    stack: opts.stack,
    provider: opts.provider,
    agentId: opts.agentId,
    operators: opts.operators,
    allow: opts.allow,
    strict: opts.strict,
    listen,
    installedAt: (deps.now ?? (() => new Date()))().toISOString(),
  }
  const token = (deps.token ?? (() => randomBytes(32).toString('hex')))()

  io.step('Writing the configuration and the unit')
  for (const [file, mode, contents] of [
    [HOST_AGENT_CONFIG_PATH, '0644', JSON.stringify(config, null, 2) + '\n'],
    [AGENT_ENV_PATH, '0600', `CLAWOPS_MCP_TOKEN=${token}\n`],
    [UNIT_PATH, '0644', unitFile(listen)],
  ] as const) {
    const r = await writeRootFile(session, file, mode, contents, signal)
    if (r.code !== 0) return { ok: false, stage: 'install', failures: [`${file}: ${errText(r)}`] }
  }
  const state = await asRoot(session, `mkdir -p ${HOST_AGENT_STATE_DIR} && chmod 0700 ${HOST_AGENT_STATE_DIR}`, signal)
  if (state.code !== 0) return { ok: false, stage: 'install', failures: [`${HOST_AGENT_STATE_DIR}: ${errText(state)}`] }

  // A hardened host denies incoming traffic from the bridge too.
  const ufw = await asRoot(session, 'ufw status 2>/dev/null || true', signal)
  if (ufw.stdout.includes('Status: active')) {
    io.step('Letting the gateway container through the firewall')
    const r = await asRoot(session, ufwAllowRule(listen), signal)
    if (r.code !== 0) return { ok: false, stage: 'install', failures: [`ufw: ${errText(r)}`] }
  }

  // 5. Start, and wait for it to answer. 401 is the answer: it is up and wants the token.
  io.step('Starting clawops-agent.service')
  const start = await asRoot(session, `systemctl daemon-reload && systemctl enable ${UNIT_NAME} >/dev/null 2>&1 && systemctl restart ${UNIT_NAME}`, signal)
  if (start.code !== 0) return { ok: false, stage: 'start', failures: [`systemctl: ${errText(start)}`] }
  const deadline = Date.now() + (deps.startTimeoutMs ?? 20_000)
  let answered = false
  while (Date.now() < deadline) {
    const probe = await session.exec(`curl -s -o /dev/null -w '%{http_code}' -X POST http://${address}:${port}/`, signal)
    if (probe.stdout.trim() === '401') { answered = true; break }
    await new Promise((r) => setTimeout(r, deps.pollMs ?? 1000))
  }
  if (!answered) {
    const journal = await asRoot(session, `journalctl -u ${UNIT_NAME} -n 30 --no-pager 2>&1 || true`, signal)
    await asRoot(session, `systemctl disable --now ${UNIT_NAME} >/dev/null 2>&1 || true`, signal)
    return { ok: false, stage: 'start', failures: [`The host agent did not answer on ${address}:${port}. It was stopped. Its log:\n${journal.stdout.trim()}`] }
  }

  // 6. Wire the gateway to it. `openclaw mcp add` probes before it saves.
  io.step('Wiring the gateway to the host agent')
  const url = `http://host.docker.internal:${port}/`
  const wired = await (deps.wire ?? defaultWire)(session, signal, url, token)
  if (!wired.ok) {
    await asRoot(session, `systemctl disable --now ${UNIT_NAME} >/dev/null 2>&1 || true`, signal)
    return { ok: false, stage: 'wire', failures: [`The gateway could not reach the host agent, which was stopped: ${wired.error}`] }
  }

  // Wiring rewrote openclaw.json. Say so if that broke anything, rather than leave the agent
  // refusing every call with nobody told why.
  const final = await readRemoteConfig(session, signal)
  const finalCheck = checkGuardrail(final, subject)
  return {
    ok: true,
    deniedAdded,
    reach: opts.strict ? [] : containerReach(final, opts.agentId),
    url,
    afterWire: finalCheck.ok ? [] : finalCheck.failures,
  }
}

export interface UninstallResult {
  removed: string[]
  kept: string[]
  failures: string[]
}

/**
 * Removes what install added, except the deny entries (they only keep clawops from agents) and,
 * unless `purge`, the state directory, which holds the host agent's audit log.
 */
export async function uninstallHostAgent(
  session: SshSession,
  opts: { purge: boolean },
  io: InstallIo,
  signal?: AbortSignal,
): Promise<UninstallResult> {
  const removed: string[] = []
  const failures: string[] = []

  io.step('Unwiring the gateway')
  const shown = await execPrivileged(session, `${OC} mcp show clawops`, signal)
  if (shown.code === 0) {
    const unset = await execPrivileged(session, `${OC} mcp unset clawops`, signal)
    if (unset.code === 0) {
      await execPrivileged(session, `${OC} mcp reload`, signal)
      removed.push('the gateway\'s clawops MCP entry')
    } else failures.push(`openclaw mcp unset clawops: ${errText(unset)}`)
  }

  const cfg = await asRoot(session, `cat ${HOST_AGENT_CONFIG_PATH} 2>/dev/null || true`, signal)
  const listen = listenFrom(cfg.stdout)

  io.step('Stopping and removing clawops-agent.service')
  const stop = await asRoot(session, `systemctl disable --now ${UNIT_NAME} >/dev/null 2>&1 || true; rm -f ${UNIT_PATH}; systemctl daemon-reload`, signal)
  if (stop.code === 0) removed.push(UNIT_PATH)
  else failures.push(`systemctl: ${errText(stop)}`)

  if (listen) {
    const ufw = await asRoot(session, 'ufw status 2>/dev/null || true', signal)
    if (ufw.stdout.includes(HOST_AGENT_UFW_COMMENT)) {
      const r = await asRoot(session, ufwDeleteRule(listen), signal)
      if (r.code === 0) removed.push('the ufw rule for the gateway container')
      else failures.push(`ufw: ${errText(r)}`)
    }
  }

  const paths = [AGENT_ROOT, AGENT_ETC, ...(opts.purge ? [HOST_AGENT_STATE_DIR] : [])]
  const rm = await asRoot(session, `rm -rf ${paths.join(' ')}`, signal)
  if (rm.code === 0) removed.push(...paths)
  else failures.push(`rm: ${errText(rm)}`)

  return {
    removed,
    kept: [
      `the ${CLAWOPS_TOOL_PATTERN} deny entries on other agents (they only keep clawops from them)`,
      ...(opts.purge ? [] : [`${HOST_AGENT_STATE_DIR} (the host agent's audit log and handoffs; --purge removes it)`]),
    ],
    failures,
  }
}
