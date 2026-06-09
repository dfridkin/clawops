// Core types for the clawops hardening framework.
// Each hardening option is a HardeningModule with idempotent check/apply.

export type ModuleStatus = 'applied' | 'missing' | 'drifted' | 'skipped'

export interface CheckResult {
  status: ModuleStatus
  /** Human-readable detail surfaced in doctor and harden --dry-run output. */
  detail: string
}

export interface ApplyResult {
  /** true = change was made; false = already satisfied, nothing done */
  changed: boolean
  detail: string
}

/**
 * A hardening module encapsulates a single idempotent security measure.
 *
 * Lifecycle per `clawops harden` run:
 *   1. check()  — read current state (non-destructive, SSH exec)
 *   2. if status !== 'applied': apply()  — make the change (SSH exec)
 *   3. Record result in summary table
 *
 * Sentinel file convention: each module writes
 * /etc/clawops/hardening/<id>.applied on success so check() can short-circuit
 * without re-reading full system config.
 */
export interface HardeningModule {
  /** Stable kebab-case identifier used in --options CSV and sentinel filenames. */
  readonly id: string
  /** Human label shown in wizard and summary table. */
  readonly label: string
  /** Pre-checked in the wizard multi-select by default. */
  readonly defaultOn: boolean
  /**
   * Providers this module applies to. 'all' means every provider.
   * Cloud-specific modules list their provider explicitly so the wizard
   * hides them for irrelevant stacks.
   */
  readonly providers: 'all' | Array<'aws' | 'gcp' | 'azure' | 'local'>
  /**
   * Read current state. Must not make any changes.
   * Receives a function to run a shell command on the remote host.
   */
  check(exec: RemoteExec): Promise<CheckResult>
  /**
   * Apply the hardening change idempotently.
   * Called only when check() returns status !== 'applied'.
   */
  apply(exec: RemoteExec): Promise<ApplyResult>
}

/**
 * Function that executes a shell command on the remote host via SSH.
 * Returns stdout, stderr, and exit code.
 */
export type RemoteExec = (
  command: string,
  opts?: { signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string; code: number }>

/** Summary entry produced after running a module. */
export interface ModuleRunResult {
  module: HardeningModule
  checkResult: CheckResult
  applyResult?: ApplyResult
  /** Wall-clock time for the check + apply cycle. */
  durationMs: number
  error?: string
}

/** Options passed to runHardening(). */
export interface HardenOpts {
  /** Modules to run; if empty, runs all modules with defaultOn=true. */
  modules: HardeningModule[]
  dryRun?: boolean
  signal?: AbortSignal
  /** Called after each module completes. */
  onProgress?: (result: ModuleRunResult) => void
}

export const SENTINEL_DIR = '/etc/clawops/hardening'
