// Diagnostics — the checks behind `clawops doctor`, as data.
//
// These used to live inside the citty command, writing to stdout as they went. That made
// them unreachable from anywhere else: R15 forbids a stdio MCP server from writing to
// stdout at all, so `clawops doctor` could not be exposed as a tool without corrupting the
// protocol on every call. The checks are the useful part; printing is one consumer of them.
//
// So a check returns a verdict and the CLI renders it. The MCP tool serialises the same
// report. Neither owns the logic.

import process from 'node:process'
import { accessSync, mkdirSync, constants } from 'node:fs'
import path from 'node:path'
import {
  PUBLISH_INSPECT_CMD, publishForRestart, STATE_DIR_HOST_LINUX,
} from '../openclaw/runtime.js'
import { GATEWAY_PORT } from '../openclaw/run-flags.js'
import { probeCommand, interpretProbe } from '../openclaw/health.js'
import { execPrivileged } from '../transport/privileged.js'
import type { SshSession } from '../transport/ssh.js'
import type { ClawopsConfig } from '../config/store.js'

/**
 * `fail` means something is wrong that clawops can name. `warn` means something worth
 * knowing that is not, by itself, broken. `info` is a check that did not apply.
 *
 * Only `fail` decides the report's `ok` — a fresh machine with no stacks yet is full of
 * warnings and is not unhealthy.
 */
export type CheckStatus = 'pass' | 'fail' | 'warn' | 'info'

export interface Check {
  /** Short label, e.g. "SSH key". Rendered in a fixed-width column. */
  name: string
  status: CheckStatus
  /** The value or the reason. Absent when the name says everything. */
  detail?: string
  /** What to do about a fail or warn, when there is something to do. */
  remedy?: string
}

export interface Section {
  title: string
  checks: Check[]
}

export interface DiagnosticsReport {
  sections: Section[]
  /** No check failed. Warnings do not clear this flag, and do not set it. */
  ok: boolean
  counts: { pass: number; fail: number; warn: number; info: number }
}

export interface DiagnosticsOpts {
  /** Include remote health and hardening checks against this stack. */
  stack?: string
  signal?: AbortSignal
}

// A live SSH session is expensive and the remote sections need two of them; injecting the
// opener keeps the module testable without an SSH server.
export interface DiagnosticsDeps {
  openSession?: (stack: string, signal?: AbortSignal) => Promise<{
    session: SshSession
    release: () => void
    conn: { host: string; port: number; user: string; privateKeyPath: string; knownHostsPath: string }
  }>
}

export async function runDiagnostics(
  opts: DiagnosticsOpts = {},
  deps: DiagnosticsDeps = {},
): Promise<DiagnosticsReport> {
  const { getConfig, getConfigDir } = await import('../config/store.js')
  const config = getConfig()
  const sections: Section[] = []

  sections.push({ title: 'Runtime', checks: runtimeChecks(getConfigDir()) })
  sections.push({
    title: 'Config',
    checks: [
      config
        ? { name: 'Config file', status: 'pass', detail: path.join(getConfigDir(), 'config.json') }
        : { name: 'Config file', status: 'warn', detail: 'not found', remedy: 'run `clawops init`' },
    ],
  })
  sections.push({ title: 'SSH', checks: sshChecks(config) })
  sections.push({ title: 'Credentials', checks: await credentialChecks(config) })
  sections.push({ title: 'OpenClaw', checks: await versionChecks() })

  if (opts.stack) {
    const open = deps.openSession ?? defaultOpenSession
    let handle: Awaited<ReturnType<typeof defaultOpenSession>> | undefined
    try {
      handle = await open(opts.stack, opts.signal)
    } catch (err) {
      sections.push({
        title: 'Remote health',
        checks: [{ name: 'Connection', status: 'fail', detail: messageOf(err) }],
      })
    }
    if (handle) {
      try {
        sections.push({
          title: 'Remote health',
          checks: await remoteChecks(handle.session, opts.signal),
        })
        sections.push({
          title: 'Hardening',
          checks: await hardeningChecks(handle.conn, opts.stack, opts.signal),
        })
      } finally {
        handle.release()
        const { drainPool } = await import('../transport/pool.js')
        drainPool()
      }
    }
  }

  return summarise(sections)
}

export function summarise(sections: Section[]): DiagnosticsReport {
  const counts = { pass: 0, fail: 0, warn: 0, info: 0 }
  for (const s of sections) for (const c of s.checks) counts[c.status]++
  return { sections, ok: counts.fail === 0, counts }
}

// ── Local checks ──────────────────────────────────────────────────────────────

function runtimeChecks(configDir: string): Check[] {
  const checks: Check[] = []
  const nodeMajor = parseInt(process.version.slice(1).split('.')[0] ?? '0', 10)
  checks.push(
    nodeMajor >= 22
      ? { name: 'Node.js', status: 'pass', detail: process.version }
      : {
          name: 'Node.js',
          status: 'fail',
          detail: `${process.version} (requires >=22)`,
          remedy: 'install Node.js 22 or later',
        },
  )

  const pulumiHome = path.join(configDir, '.pulumi')
  try {
    mkdirSync(pulumiHome, { recursive: true })
    checks.push({ name: 'Pulumi home', status: 'pass', detail: pulumiHome })
  } catch {
    checks.push({ name: 'Pulumi home', status: 'fail', detail: `${pulumiHome} (not writable)` })
  }
  return checks
}

function expandHome(p: string): string {
  return p.replace(/^~/, process.env['HOME'] ?? '~')
}

function sshChecks(config: ClawopsConfig | null): Check[] {
  if (!config) return [{ name: 'SSH', status: 'info', detail: 'skipped — no config' }]

  const checks: Check[] = []
  const keyPath = expandHome(config.ssh.keyPath)
  try {
    accessSync(keyPath, constants.R_OK)
    checks.push({ name: 'SSH key', status: 'pass', detail: keyPath })
  } catch {
    checks.push({
      name: 'SSH key',
      status: 'fail',
      detail: `${keyPath} (not found or not readable)`,
    })
  }

  const knownHostsPath = expandHome(config.ssh.knownHostsPath)
  try {
    accessSync(knownHostsPath, constants.F_OK)
    checks.push({ name: 'known_hosts', status: 'pass', detail: knownHostsPath })
  } catch {
    checks.push({
      name: 'known_hosts',
      status: 'warn',
      detail: `${knownHostsPath} (does not exist — will be created on first connect)`,
    })
  }
  return checks
}

async function credentialChecks(config: ClawopsConfig | null): Promise<Check[]> {
  if (!config) return [{ name: 'Credentials', status: 'info', detail: 'skipped — no config' }]

  const { getProvider } = await import('../providers/index.js')
  await Promise.all([
    import('../providers/aws/index.js'),
    import('../providers/gcp/index.js'),
    import('../providers/azure/index.js'),
    import('../providers/local/index.js'),
  ])

  const checks: Check[] = []
  const seen = new Set<string>()
  for (const [stackName, stackCfg] of Object.entries(config.stacks)) {
    const providerName = stackCfg.provider
    if (seen.has(providerName)) continue
    seen.add(providerName)

    if (providerName === 'local') {
      checks.push({
        name: providerName,
        status: 'pass',
        detail: `stack "${stackName}" (SSH-only, no cloud credentials required)`,
      })
      continue
    }
    try {
      const adapter = getProvider(providerName as 'aws' | 'gcp' | 'azure')
      const result = await adapter.validateConfig()
      if (result.ok) {
        checks.push({ name: providerName, status: 'pass', detail: `stack "${stackName}"` })
      } else {
        for (const err of result.errors) {
          checks.push({ name: providerName, status: 'fail', detail: `stack "${stackName}" — ${err}` })
        }
      }
    } catch (err) {
      checks.push({
        name: providerName,
        status: 'fail',
        detail: `stack "${stackName}" — ${messageOf(err)}`,
      })
    }
  }
  if (seen.size === 0) {
    checks.push({ name: 'Stacks', status: 'warn', detail: 'none configured', remedy: 'run `clawops init`' })
  }
  return checks
}

async function versionChecks(): Promise<Check[]> {
  try {
    const yaml = await import('js-yaml')
    const { loadVersionSpec, describeRange } = await import('../openclaw/versions.js')
    const support = loadVersionSpec(yaml).support
    const checks: Check[] = [
      {
        name: 'Supported range',
        status: 'pass',
        detail: `${describeRange(support)} (recommended ${support.recommended})`,
      },
    ]
    if (!support.max) {
      checks.push({
        name: 'Upper bound',
        status: 'warn',
        detail: 'none declared — this line would accept any OpenClaw release',
      })
    }
    return checks
  } catch (e) {
    return [{ name: 'Version matrix', status: 'fail', detail: messageOf(e) }]
  }
}

// ── Remote checks ─────────────────────────────────────────────────────────────

export async function remoteChecks(session: SshSession, signal?: AbortSignal): Promise<Check[]> {
  const checks: Check[] = []

  const containerResult = await execPrivileged(
    session,
    `docker inspect openclaw --format '{{.State.Status}}' 2>/dev/null || echo 'not found'`,
    signal,
  )
  const containerStatus = containerResult.stdout.trim()
  checks.push(
    containerStatus === 'running'
      ? { name: 'Container', status: 'pass', detail: 'running' }
      : { name: 'Container', status: 'fail', detail: containerStatus || 'unknown' },
  )

  // Deployed OpenClaw version — the half that helps users who ALREADY ran `clawops up`
  // with a moving tag and are now on an unsupported release. Refusing future operations
  // does nothing for them.
  const imageResult = await execPrivileged(
    session,
    `docker inspect openclaw --format '{{.Config.Image}}' 2>/dev/null || echo ''`,
    signal,
  )
  const image = imageResult.stdout.trim()
  const deployedVersion = image.includes(':') ? image.slice(image.lastIndexOf(':') + 1) : ''
  if (deployedVersion) {
    checks.push(await deployedVersionCheck(image, deployedVersion))
  }

  // Does the gateway actually answer? A running container says the process started, not
  // that it serves. `/startupz` is the gate a deploy waits on, so it is the one to ask.
  const probe = await session.exec(probeCommand('started', GATEWAY_PORT), signal)
  const verdict = interpretProbe('started', probe.stdout)
  checks.push(
    verdict.ok
      ? { name: 'Gateway', status: 'pass', detail: `answering on 127.0.0.1:${GATEWAY_PORT}` }
      : { name: 'Gateway', status: 'fail', detail: verdict.reason ?? 'not answering' },
  )

  // Reachability — the one property a green probe says nothing about. A gateway published
  // on 0.0.0.0 serves plaintext HTTP to anyone the firewall admits.
  const pubResult = await execPrivileged(session, PUBLISH_INSPECT_CMD, signal)
  checks.push(
    publishForRestart(pubResult.stdout) === 'all'
      ? {
          name: 'Published',
          status: 'warn',
          detail: '0.0.0.0 — the gateway port is open on every interface, serving plaintext HTTP',
          remedy: 'front it with TLS, or set network.publishGateway to "loopback" and use `clawops tunnel`',
        }
      : { name: 'Published', status: 'pass', detail: '127.0.0.1 only (reach it with `clawops tunnel`)' },
  )

  const diskResult = await session.exec(
    // The state directory: 2.0's SQLite lives there, not in the user's home.
    `df -h ${STATE_DIR_HOST_LINUX} 2>/dev/null | awk 'NR==2{print $5" used ("$3" of "$2")"}'`,
    signal,
  )
  const diskUsage = diskResult.stdout.trim()
  if (diskUsage) {
    const pct = parseInt(diskUsage.match(/^(\d+)%/)?.[1] ?? '0', 10)
    checks.push({
      name: 'Disk',
      status: pct >= 90 ? 'fail' : pct >= 75 ? 'warn' : 'pass',
      detail: diskUsage,
    })
  } else {
    checks.push({ name: 'Disk', status: 'warn', detail: 'unable to determine disk usage' })
  }

  const logrotateResult = await session.exec(
    `test -f /etc/logrotate.d/openclaw && echo 'configured' || echo 'not configured'`,
    signal,
  )
  checks.push(
    logrotateResult.stdout.trim() === 'configured'
      ? { name: 'Log rotation', status: 'pass', detail: 'configured' }
      : { name: 'Log rotation', status: 'warn', detail: 'not configured — logs may grow unbounded' },
  )

  return checks
}

async function deployedVersionCheck(image: string, deployedVersion: string): Promise<Check> {
  const yaml = await import('js-yaml')
  const { loadVersionSpec, checkVersion, isMovingTag } = await import('../openclaw/versions.js')
  const support = loadVersionSpec(yaml).support

  if (isMovingTag(deployedVersion)) {
    return {
      name: 'Deployed',
      status: 'warn',
      detail: `${image} (moving tag)`,
      remedy: 'pin an explicit version — a moving tag resolves to whatever is newest',
    }
  }
  const check = checkVersion(deployedVersion, support)
  if (check.ok) return { name: 'Deployed', status: 'pass', detail: `OpenClaw ${deployedVersion}` }

  return {
    name: 'Deployed',
    status: 'fail',
    detail: `OpenClaw ${deployedVersion} is not supported by this clawops line`,
    remedy:
      check.error.reason === 'too-old'
        ? 'this clawops line requires OpenClaw 2.0 or later — run `clawops migrate` to move an ' +
          'existing 1.x deployment across, which preserves its state and device identity'
        : 'upgrade clawops, or pin an OpenClaw version this line supports',
  }
}

async function hardeningChecks(
  conn: { host: string; port: number; user: string; privateKeyPath: string; knownHostsPath: string },
  stack: string,
  signal?: AbortSignal,
): Promise<Check[]> {
  try {
    const { MODULE_CATALOG, resolveModules, withRemoteExec } = await import('../harden/index.js')
    const { buildContext } = await import('../cli/context.js')
    const provider = buildContext({ stack }).adapter.name
    const modules = resolveModules(MODULE_CATALOG, undefined, provider)

    const checks: Check[] = []
    await withRemoteExec(conn, signal, async (exec) => {
      for (const mod of modules) {
        const result = await mod.check(exec)
        if (result.status === 'applied') {
          checks.push({ name: mod.label, status: 'pass', detail: 'applied' })
        } else if (result.status === 'drifted') {
          checks.push({ name: mod.label, status: 'warn', detail: `drifted — ${result.detail}` })
        } else if (result.status === 'missing') {
          checks.push({ name: mod.label, status: 'info', detail: 'not applied', remedy: 'run `clawops harden`' })
        }
        // 'skipped' modules do not apply to this provider; omit them rather than
        // reporting a check that was never going to run.
      }
    })
    return checks
  } catch (err) {
    return [{ name: 'Hardening checks', status: 'fail', detail: messageOf(err) }]
  }
}

// ── Session ───────────────────────────────────────────────────────────────────

async function defaultOpenSession(stack: string, signal?: AbortSignal) {
  const { getConfig } = await import('../config/store.js')
  const { buildContext } = await import('../cli/context.js')
  const { extractBaseOutputs } = await import('../pulumi/outputs.js')
  const { acquireSession } = await import('../transport/pool.js')

  const config = getConfig()
  if (!config) throw new Error('no config — run `clawops init`')

  const ctx = buildContext({ stack })
  const stackObj = await ctx.getStack()
  const outputMap = await stackObj.outputs()
  const outputs: Record<string, unknown> = Object.fromEntries(
    Object.entries(outputMap).map(([k, v]) => [k, v.value]),
  )
  const base = extractBaseOutputs(outputs)
  const conn = ctx.adapter.getConnectionInfo({
    ...base,
    privateKeyPath: config.ssh.keyPath,
    knownHostsPath: config.ssh.knownHostsPath,
  })

  const { session, release } = await acquireSession({
    host: conn.host,
    port: conn.port,
    user: conn.user,
    privateKeyPath: conn.privateKeyPath,
    knownHostsPath: conn.knownHostsPath,
    signal,
  })
  return { session, release, conn }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
