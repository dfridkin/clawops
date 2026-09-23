// ~/.clawops/config.json management.
// Per R6: no secrets stored here.
// Uses synchronous file I/O — config is read once at startup.

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { z } from 'zod'
import { UsageError, StateError } from '../errors/index.js'

const CredentialsRefSchema = z.object({
  source: z.enum(['env', 'cli-profile', 'file', 'instance-metadata']),
  envVars: z.array(z.string()).optional(),
  profileName: z.string().optional(),
})

const LocalOptsSchema = z.object({
  host: z.string(),
  sshUser: z.string(),
  sshPort: z.number(),
  sshKeyPath: z.string(),
})

/**
 * Where clawops reaches a stack once it is on a tailnet.
 *
 * An override rather than a rewrite. The SSH host is never stored: every command derives it from
 * the Pulumi output `sshHost`, so there is no field for Tailscale to replace and nothing that has
 * to be backed up first. Setting this points clawops at the tailnet address; deleting it points
 * clawops back at the public one, with nothing to restore. WO-34 specified a `_preTailscale`
 * backup of `sshHost`, written against a config shape this project does not have.
 *
 * Only written after an SSH session over the address has succeeded against a host key pinned
 * through the public connection, so its presence means the address was verified, not assumed.
 */
const TailscaleOverrideSchema = z.object({
  ip: z.string(),
  hostname: z.string().optional(),
  /** When the address was verified, ISO 8601. */
  verifiedAt: z.string(),
  /** Set once --private-only has closed the public ports, so revert knows to reopen them. */
  privateOnly: z.boolean().optional(),
})

const StackConfigSchema = z.object({
  provider: z.string(),
  stateUrl: z.string(),
  region: z.string().optional(),
  credentialsRef: CredentialsRefSchema,
  localOpts: LocalOptsSchema.optional(),
  tailscale: TailscaleOverrideSchema.optional(),
})

export type TailscaleOverride = z.infer<typeof TailscaleOverrideSchema>

const ClawopsConfigSchema = z.object({
  version: z.literal(1),
  defaults: z.object({
    stack: z.string(),
    provider: z.string(),
  }),
  stacks: z.record(StackConfigSchema),
  ssh: z.object({
    keyPath: z.string(),
    knownHostsPath: z.string(),
  }),
  mcp: z.object({ auditLogPath: z.string() }).optional(),
})

export type ClawopsConfig = z.infer<typeof ClawopsConfigSchema>
export type StackConfig = z.infer<typeof StackConfigSchema>
export type CredentialsRef = z.infer<typeof CredentialsRefSchema>

export function getConfigDir(): string {
  return process.env['CLAWOPS_HOME'] ?? path.join(os.homedir(), '.clawops')
}

export function getConfigPath(): string {
  return path.join(getConfigDir(), 'config.json')
}

/** Read and validate ~/.clawops/config.json. Returns null if file not found. */
export function getConfig(): ClawopsConfig | null {
  try {
    const raw = readFileSync(getConfigPath(), 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    const result = ClawopsConfigSchema.safeParse(parsed)
    if (!result.success) {
      throw new StateError(
        `Config file is invalid: ${result.error.issues.map(i => i.message).join(', ')}. ` +
          'Run `clawops init` to reinitialise.',
      )
    }
    return result.data
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/**
 * Like getConfig() but throws UsageError if the file is missing.
 *
 * The message names the file and says who can create it. `clawops init` is a terminal command
 * and there is no tool for it, so an agent reading "run clawops init" was being told to do the
 * one thing it cannot — which is what every MCP client sees on a machine that has never run
 * clawops, and what an evaluator in a fresh sandbox sees from every tool they try.
 */
export function requireConfig(): ClawopsConfig {
  const cfg = getConfig()
  if (!cfg) {
    throw new UsageError(
      `No clawops config at ${getConfigPath()}. Create one with \`clawops init\` in a terminal, ` +
        'or by calling the clawops_init tool. Either way it registers a stack — a provider and a ' +
        'state backend — and generates an SSH key; nothing is provisioned and nothing is charged.',
    )
  }
  return cfg
}

/**
 * Atomically write config to disk.
 * Creates the config directory if it doesn't exist.
 */
export function setConfig(config: ClawopsConfig): void {
  const dir = getConfigDir()
  mkdirSync(dir, { recursive: true })
  const dest = getConfigPath()
  const tmp = path.join(dir, `.config.${randomUUID()}.tmp`)
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', 'utf-8')
  renameSync(tmp, dest)
}
