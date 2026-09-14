// Pulumi Automation API wrapper.
// Per SPEC §4: no pulumi.yaml on disk; inline program; state backend via env var.

import path from 'node:path'
import { LocalWorkspace, type Stack } from '@pulumi/pulumi/automation'
import type { PulumiFn } from '../providers/types.js'
import { getConfigDir } from '../config/store.js'
import { ensurePulumiCli } from './cli.js'
import { ensurePassphrase } from './passphrase.js'

export interface StackOpts {
  stack: string
  stateUrl: string
  program: PulumiFn
  /** Defaults to getConfigDir() if not provided. */
  configDir?: string
  /** Notified once if the Pulumi CLI has to be installed first. Defaults to a stderr line. */
  onInstall?: (info: { root: string }) => void
}

/**
 * Create or select a Pulumi stack backed by the given state URL.
 * The workspace is ephemeral (no pulumi.yaml written to disk).
 * pulumiHome is sandboxed under ~/.clawops/.pulumi.
 *
 * The workspace is given an explicit `pulumiCommand`. Left to itself it spawns bare `pulumi`
 * and fails on any machine without one on $PATH; see ./cli.ts.
 */
export async function getOrCreateStack(opts: StackOpts): Promise<Stack> {
  const configDir = opts.configDir ?? getConfigDir()
  const pulumiCommand = await ensurePulumiCli({ configDir, onInstall: opts.onInstall })
  const passphrase = ensurePassphrase(configDir)
  return await LocalWorkspace.createOrSelectStack(
    {
      stackName: opts.stack,
      projectName: 'clawops',
      program: opts.program,
    },
    {
      pulumiCommand,
      pulumiHome: path.join(configDir, '.pulumi'),
      envVars: {
        PULUMI_BACKEND_URL: opts.stateUrl,
        PULUMI_SKIP_UPDATE_CHECK: '1',
        // A self-managed backend has no key service, so a new stack cannot be created without
        // a secrets manager, and the only one available is a passphrase. Undefined when the
        // operator supplies their own — overriding it would orphan their existing stacks.
        // See ./passphrase.ts and ADR 0011.
        ...(passphrase ? { PULUMI_CONFIG_PASSPHRASE: passphrase } : {}),
        // R6: cloud credentials inherited from process.env, never set here
      },
    },
  )
}
