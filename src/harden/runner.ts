// Hardening runner — executes HardeningModules via SSH and renders results.

import { Readable } from 'node:stream'
import { acquireSession, drainPool } from '../transport/pool.js'
import type { ConnectionInfo } from '../providers/types.js'
import type { SshSession } from '../transport/ssh.js'
import type {
  HardeningModule,
  HardenOpts,
  ModuleRunResult,
  RemoteExec,
} from './types.js'

/**
 * Run a set of hardening modules against a remote host.
 * Returns one ModuleRunResult per module in the same order as opts.modules.
 */
/**
 * The one way a RemoteExec is built from a session.
 *
 * There were two. runHardening built its own, and when `stdin` was added to RemoteExec so a
 * secret could reach a host without entering a command line, only withRemoteExec learned to
 * honour it. runHardening is what `clawops harden` actually runs modules through, so there the
 * option was silently dropped: the Tailscale join read an empty stdin and wrote an empty key
 * file, and the key never reached the host at all. The live test that passed had called
 * withRemoteExec directly, which is to say it tested the other implementation.
 *
 * A single constructor means an option added to RemoteExec reaches every module or none.
 */
export function remoteExecFor(session: SshSession, signal: AbortSignal | undefined): RemoteExec {
  return (command, execOpts) =>
    execOpts?.stdin === undefined
      ? session.exec(command, execOpts?.signal ?? signal)
      : session.execWithInput(command, Readable.from([execOpts.stdin]), execOpts.signal ?? signal)
}

export async function runHardening(
  conn: ConnectionInfo,
  opts: HardenOpts,
): Promise<ModuleRunResult[]> {
  const { session, release } = await acquireSession({
    host: conn.host,
    port: conn.port,
    user: conn.user,
    privateKeyPath: conn.privateKeyPath,
    knownHostsPath: conn.knownHostsPath,
    signal: opts.signal,
  })

  const exec = remoteExecFor(session, opts.signal)

  const results: ModuleRunResult[] = []

  try {
    for (const mod of opts.modules) {
      if (opts.signal?.aborted) break

      const start = Date.now()
      let checkResult
      let applyResult
      let error: string | undefined

      try {
        checkResult = await mod.check(exec)

        if (!opts.dryRun && checkResult.status !== 'applied') {
          applyResult = await mod.apply(exec)
        }
      } catch (err) {
        error = err instanceof Error ? err.message : String(err)
        checkResult ??= { status: 'drifted' as const, detail: error }
      }

      const result: ModuleRunResult = {
        module: mod,
        checkResult,
        applyResult,
        durationMs: Date.now() - start,
        error,
      }

      results.push(result)
      opts.onProgress?.(result)
    }
  } finally {
    release()
    drainPool()
  }

  return results
}

/**
 * Build a RemoteExec function from a ConnectionInfo without acquiring a
 * persistent pool session. Useful for one-off checks in doctor.
 */
export async function withRemoteExec<T>(
  conn: ConnectionInfo,
  signal: AbortSignal | undefined,
  fn: (exec: RemoteExec) => Promise<T>,
): Promise<T> {
  const { session, release } = await acquireSession({
    host: conn.host,
    port: conn.port,
    user: conn.user,
    privateKeyPath: conn.privateKeyPath,
    knownHostsPath: conn.knownHostsPath,
    signal,
  })
  try {
    return await fn(remoteExecFor(session, signal))
  } finally {
    release()
  }
}

/** Render a summary table of ModuleRunResults to a string. */
export function formatHardenSummary(results: ModuleRunResult[]): string {
  const rows = results.map((r) => {
    const icon = r.error
      ? '✗'
      : r.applyResult?.changed
        ? '✓'
        : r.checkResult.status === 'applied'
          ? '·'
          : '⚠'
    const action = r.error
      ? 'error'
      : r.applyResult?.changed
        ? 'applied'
        : r.checkResult.status === 'applied'
          ? 'already ok'
          : 'skipped (dry-run)'
    const detail = r.error ?? r.applyResult?.detail ?? r.checkResult.detail
    return `  ${icon}  ${r.module.label.padEnd(30)} ${action.padEnd(16)} ${detail}`
  })

  const changed = results.filter((r) => r.applyResult?.changed).length
  const errors = results.filter((r) => r.error).length
  const already = results.filter(
    (r) => !r.error && !r.applyResult?.changed && r.checkResult.status === 'applied',
  ).length

  const summary = `\n  ${changed} applied  ${already} already ok  ${errors} errors`
  return rows.join('\n') + '\n' + summary + '\n'
}

/**
 * Resolve the list of modules to run from an --options CSV string.
 * If options is empty/undefined, returns all modules with defaultOn=true.
 */
export function resolveModules(
  catalog: HardeningModule[],
  options: string | undefined,
  provider: string,
): HardeningModule[] {
  const providerFiltered = catalog.filter(
    (m) => m.providers === 'all' || (m.providers as string[]).includes(provider),
  )

  if (!options?.trim()) {
    return providerFiltered.filter((m) => m.defaultOn)
  }

  const ids = new Set(options.split(',').map((s) => s.trim()).filter(Boolean))
  return providerFiltered.filter((m) => ids.has(m.id))
}
