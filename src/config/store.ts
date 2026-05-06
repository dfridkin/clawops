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

const StackConfigSchema = z.object({
  provider: z.string(),
  stateUrl: z.string(),
  region: z.string().optional(),
  credentialsRef: CredentialsRefSchema,
})

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

/** Like getConfig() but throws UsageError if the file is missing. */
export function requireConfig(): ClawopsConfig {
  const cfg = getConfig()
  if (!cfg) {
    throw new UsageError('No config found. Run `clawops init` first.')
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
