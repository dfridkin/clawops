// Everything `clawops migrate` does around the sequence in ./migrate.ts: choosing and guarding
// the target, reaching the host, the effects each step performs on it, and how the outcome reads.
//
// Shared by the CLI command and the clawops_migrate MCP tool so the two cannot drift in what
// they run or refuse. Nothing here prints or exits: progress is reported through `onStep`, and
// the outcome comes back as levelled lines for the caller to render (R15 — a stdio MCP server
// must never write to stdout). Errors that are refusals are thrown as UsageError, the CLI's
// boundary type; the MCP tool returns their message unchanged.

import type { ClawopsContext } from '../cli/context.js'
import type { SshExecResult } from '../transport/ssh.js'
import {
  STATE_DIR_HOST_LINUX, CONFIG_FILENAME, CONTAINER_UID, GATEWAY_PORT, gatewayRunCommand,
} from './runtime.js'
import { probeCommand, interpretProbe } from './health.js'
import { migrate, describeMigration, type MigrateSteps, type MigrateOutcome } from './migrate.js'

/** Where the pre-migration backup is written on the host. */
export const PREMIGRATION_ARCHIVE = '/tmp/clawops-premigration.tar.gz'

/** The config 1.x never had. Minimal and valid: enough for 2.0 to start. */
export const SYNTHESISED_CONFIG = JSON.stringify({
  meta: { lastTouchedVersion: '2026.9.2' },
  gateway: { mode: 'local', port: GATEWAY_PORT, auth: { mode: 'token' } },
  models: {},
  channels: {},
})

export interface MigrationTarget {
  ctx: ClawopsContext
  stackName: string
  /** The concrete OpenClaw 2.x release to migrate to. */
  version: string
  image: string
}

/**
 * Resolve the stack and the target release, refusing an unsupported target.
 *
 * Guards the TARGET only. The source is a 1.x release this line refuses by design — that is
 * the whole reason to migrate — so running the guard over it would refuse the very deployment
 * this exists to rescue.
 *
 * Throws UsageError for an unsupported version or an unknown stack.
 */
export async function prepareMigration(args: {
  stack?: string | undefined
  openclawVersion?: string | undefined
}): Promise<MigrationTarget> {
  const { buildContext } = await import('../cli/context.js')
  const { guardOpenclawVersion, defaultOpenclawVersion } = await import('../cli/version-guard.js')

  const version = args.openclawVersion
    ? await guardOpenclawVersion(args.openclawVersion)
    : await defaultOpenclawVersion()
  const ctx = buildContext({ stack: args.stack })
  return { ctx, stackName: ctx.stackName, version, image: `ghcr.io/openclaw/openclaw:${version}` }
}

/** The effects of each step, on a host reached through `run`. */
export function migrationSteps(
  run: (cmd: string) => Promise<SshExecResult>,
  opts: { targetImage: string; signal?: AbortSignal; onStep?: (text: string) => void },
): MigrateSteps {
  const step = opts.onStep ?? (() => {})
  const archive = PREMIGRATION_ARCHIVE
  const configPath = `${STATE_DIR_HOST_LINUX}/${CONFIG_FILENAME}`

  return {
    inspectSource: async () => {
      const r = await run(`docker inspect openclaw --format '{{.Config.Image}}'`)
      const image = r.stdout.trim()
      return r.code === 0 && image.includes(':') ? image : undefined
    },

    backup: async () => {
      step('Taking a verified backup...')
      // Inside the RUNNING 1.x container — verified present in 2026.7.1 by SP-07.
      const r = await run(
        `docker exec openclaw openclaw backup create --output ${archive} --verify --json`,
      )
      return r.code === 0
        ? { ok: true, detail: `${archive} on the host (verified)` }
        : { ok: false, detail: (r.stderr || r.stdout).slice(0, 200) }
    },

    extract: async () => {
      step('Extracting state from the running container...')
      const mk = await run(`mkdir -p ${STATE_DIR_HOST_LINUX}`)
      if (mk.code !== 0) return { ok: false, entries: [] }
      // `docker cp` from the RUNNING container. Stopping first would destroy it.
      const cp = await run(`docker cp openclaw:/home/node/.openclaw/. ${STATE_DIR_HOST_LINUX}/`)
      if (cp.code !== 0) return { ok: false, entries: [] }
      const ls = await run(`ls ${STATE_DIR_HOST_LINUX}`)
      return { ok: true, entries: ls.stdout.trim().split(/\s+/).filter(Boolean) }
    },

    chown: async () => {
      // Numeric. `useradd clawops` is uid 1001 on Ubuntu 24.04 while the container runs
      // as 1000, and a mismatch makes the gateway exit 1 on its own SQLite WAL (G25).
      await run(`chown -R ${CONTAINER_UID}:${CONTAINER_UID} ${STATE_DIR_HOST_LINUX}`)
    },

    removeSource: async () => {
      step('Stopping the 1.x container...')
      await run('docker stop openclaw 2>/dev/null || true')
      await run('docker rm   openclaw 2>/dev/null || true')
    },

    writeConfig: async () => {
      // Synthesised, not carried forward: 1.x never had a config that applied, and its
      // channel blocks would not validate against the 2.0 schema.
      const b64 = Buffer.from(SYNTHESISED_CONFIG, 'utf-8').toString('base64')
      await run(
        `echo '${b64}' | base64 -d > ${configPath} && ` +
          `chown ${CONTAINER_UID}:${CONTAINER_UID} ${configPath}`,
      )
    },

    start: async () => {
      step('Starting the 2.0 gateway...')
      await run(gatewayRunCommand({ image: opts.targetImage, stateDir: STATE_DIR_HOST_LINUX }))
    },

    gate: async () => {
      step('Waiting for the gateway to start...')
      let last: string | undefined
      for (let i = 0; i < 15; i++) {
        if (opts.signal?.aborted) return { ok: false, reason: 'aborted' }
        const r = await run(probeCommand('started', GATEWAY_PORT))
        const v = interpretProbe('started', r.stdout)
        if (v.ok) return { ok: true }
        last = v.reason
        await new Promise((res) => setTimeout(res, 2000))
      }
      return { ok: false, reason: last ?? 'no response' }
    },

    deviceId: async () => {
      // Before migration it is a file; afterwards it has moved into SQLite, so read
      // whichever is present. A missing value is reported as unknown, never as continuity.
      const file = await run(
        `docker exec openclaw sh -c 'cat ~/.openclaw/identity/device.json 2>/dev/null' ` +
          `|| cat ${STATE_DIR_HOST_LINUX}/identity/device.json 2>/dev/null || true`,
      )
      try {
        const parsed = JSON.parse(file.stdout.trim()) as { deviceId?: string }
        return parsed.deviceId
      } catch {
        return undefined
      }
    },
  }
}

export type ReportLevel = 'success' | 'info' | 'warn' | 'failure'

export interface MigrationResult {
  outcome: MigrateOutcome
  /** The report, one entry per line, with the level the CLI renders it at. */
  lines: Array<{ level: ReportLevel; text: string }>
  /** 0 when nothing went wrong (including "nothing to migrate"), 1 otherwise. */
  exitCode: 0 | 1
}

/** How an outcome reads. Both surfaces render these lines; neither writes its own. */
export function migrationResult(outcome: MigrateOutcome): MigrationResult {
  const report = describeMigration(outcome)
  if (outcome.kind === 'migrated') {
    const [first, ...rest] = report.split('\n')
    return {
      outcome,
      exitCode: 0,
      lines: [
        { level: 'success', text: first! },
        ...rest.map((text) => ({
          level: (/CHANGED|could not be compared/.test(text) ? 'warn' : 'info') as ReportLevel,
          text,
        })),
        { level: 'info', text: `Pre-migration backup: ${PREMIGRATION_ARCHIVE}` },
      ],
    }
  }
  const benign = outcome.kind === 'nothing-to-migrate' || outcome.kind === 'already-current'
  return { outcome, exitCode: benign ? 0 : 1, lines: [{ level: 'failure', text: report }] }
}

/**
 * Connect to the stack's host and run the migration.
 *
 * The migration gets its own SSH connection rather than a pooled one: other commands drain the
 * pool when they finish, and a connection closed between stopping the 1.x container and
 * starting 2.0 would leave the host running neither. Throws for an unreachable host or a stack
 * with no deployment (before anything on the host is touched).
 */
export async function runMigration(
  target: MigrationTarget,
  opts: { signal?: AbortSignal; onStep?: (text: string) => void } = {},
): Promise<MigrationResult> {
  const { resolveConn } = await import('../transport/conn.js')
  const { connect } = await import('../transport/ssh.js')
  const { execPrivileged } = await import('../transport/privileged.js')
  const { loadVersionSpec } = await import('./versions.js')
  const yaml = await import('js-yaml')

  const conn = await resolveConn(target.ctx)
  const session = await connect({
    host: conn.host, port: conn.port, user: conn.user,
    privateKeyPath: conn.privateKeyPath, knownHostsPath: conn.knownHostsPath,
    ...(opts.signal ? { signal: opts.signal } : {}),
  })
  try {
    opts.onStep?.('Inspecting the deployment...')
    const steps = migrationSteps((cmd) => execPrivileged(session, cmd, opts.signal), {
      targetImage: target.image,
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.onStep ? { onStep: opts.onStep } : {}),
    })
    const outcome = await migrate(steps, { targetLineMin: loadVersionSpec(yaml).support.min })
    return migrationResult(outcome)
  } finally {
    session.close()
  }
}

/**
 * The question both surfaces ask before a migration runs. The CLI asks it at a prompt, the MCP
 * tool through elicitation; either way it is the same words, because a confirmation is part of
 * what the command does.
 */
export function migrationQuestion(target: { stackName: string; version: string }): string {
  return (
    `Migrate stack "${target.stackName}" from OpenClaw 1.x to ${target.version}? This takes a ` +
    'verified backup, then stops and replaces the running 1.x gateway container and writes ' +
    'a new minimal config. The 1.x config is not carried over.'
  )
}
