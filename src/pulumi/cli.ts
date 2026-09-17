// Locating — and if necessary installing — the Pulumi CLI.
//
// The Automation API is not an embedded engine. `LocalWorkspace` builds a command line and
// spawns it:
//
//   const command = opts?.root ? path.resolve(path.join(opts.root, "bin/pulumi")) : "pulumi"
//
// With no installation root that resolves to whatever `pulumi` is on $PATH, and on a machine
// without one every clawops command that touches a stack dies with `spawn pulumi ENOENT`
// before it reaches the provider. clawops promises the user does not install Pulumi, so
// clawops installs it: `PulumiCommand.install` fetches the CLI matching the bundled SDK into
// a directory we name and passes `--no-edit-path`, so nothing outside `~/.clawops` changes
// and the user's own `pulumi`, if they have one, is left alone.
//
// Resolution order is deliberate. Our own copy wins because its version is pinned to the SDK
// we ship, which is the version the programs were written against; a `pulumi` on $PATH is
// used when we have no copy, since a compatible CLI already on the machine is worth more than
// a download.

import path from 'node:path'
import process from 'node:process'
// `/index.js`, not the bare directory. @pulumi/pulumi ships no "exports" map and no "main", so
// `@pulumi/pulumi/automation` resolves only under CommonJS rules — which tsx and vitest apply and
// Node's ESM loader does not. Every test and every source-run cloud deploy passed with the bare
// specifier; the published bundle died on the first import, and nothing in this repo ran the
// published bundle. `pnpm verify:pack` does now.
import { PulumiCommand } from '@pulumi/pulumi/automation/index.js'

/** Where clawops keeps its own CLI. Sibling of `.pulumi` (the CLI's *home*, a different thing). */
export function pulumiCliRoot(configDir: string): string {
  return path.join(configDir, '.pulumi-cli')
}

export type PulumiCliStatus =
  | { kind: 'managed'; version: string; root: string }
  | { kind: 'path'; version: string }
  | { kind: 'missing' }

function versionOf(cmd: PulumiCommand): string {
  return cmd.version ? `v${cmd.version.toString()}` : 'unknown version'
}

/**
 * Find a usable CLI without installing one. `doctor` calls this: a diagnostic that changes
 * the thing it is diagnosing is not a diagnostic.
 */
export async function pulumiCliStatus(configDir: string): Promise<PulumiCliStatus> {
  const root = pulumiCliRoot(configDir)
  try {
    return { kind: 'managed', version: versionOf(await PulumiCommand.get({ root })), root }
  } catch {
    // no copy of ours — fall through
  }
  try {
    return { kind: 'path', version: versionOf(await PulumiCommand.get()) }
  } catch {
    return { kind: 'missing' }
  }
}

export interface EnsurePulumiCliOpts {
  configDir: string
  /**
   * Called once, before the download, when neither lookup found a CLI. The install takes tens
   * of seconds and reaches the network; a command that appears to hang is worse than a slow
   * one that said why. Defaults to a line on stderr — never stdout, which R15 reserves for the
   * MCP protocol.
   */
  onInstall?: (info: { root: string }) => void
}

/**
 * Resolve the CLI, installing it into `~/.clawops/.pulumi-cli` if there is none. Throws with
 * the manual remedy if the install itself fails — offline, or no write access.
 */
export async function ensurePulumiCli(opts: EnsurePulumiCliOpts): Promise<PulumiCommand> {
  const root = pulumiCliRoot(opts.configDir)
  const status = await pulumiCliStatus(opts.configDir)
  if (status.kind === 'managed') return await PulumiCommand.get({ root })
  if (status.kind === 'path') return await PulumiCommand.get()

  const announce = opts.onInstall ?? defaultAnnounce
  announce({ root })
  try {
    return await PulumiCommand.install({ root })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(
      `could not install the Pulumi CLI into ${root}: ${reason}\n` +
        'Install it yourself and clawops will use it: https://www.pulumi.com/docs/install/',
    )
  }
}

function defaultAnnounce({ root }: { root: string }): void {
  process.stderr.write(`Pulumi CLI not found — installing it into ${root} (one time).\n`)
}
