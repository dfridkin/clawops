// Registering a stack: the part of `clawops init` that is not a conversation.
//
// This lived inside the CLI command, mixed with prompts, printing and process.exit, so the only
// way to create a config was to be a person at a terminal. Every MCP tool needs a config, so on
// a machine that had never run clawops every tool failed the same way and told the caller to run
// a command it could not run — which is exactly what a directory's sandbox is: a fresh container
// where an evaluator tries the tools and finds all of them refusing.
//
// The conversation stays in the command. What is left here is the decision and the write, which
// the CLI and the MCP tool both perform the same way, including the refusals.

import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { setConfig, getConfigDir, getConfig } from './store.js'
import type { ClawopsConfig } from './store.js'
import { deriveStateBucket, stateUrlFor, resolveScopeAccount } from '../providers/state-bucket.js'

export const SUPPORTED_PROVIDERS = ['gcp', 'aws', 'azure', 'local'] as const
export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number]

export const PROVIDER_DEFAULTS: Record<
  Exclude<SupportedProvider, 'local'>,
  { region: string; credEnv: string; stateScheme: string }
> = {
  gcp:   { region: 'us-central1', credEnv: 'GOOGLE_APPLICATION_CREDENTIALS', stateScheme: 'gs://' },
  aws:   { region: 'us-east-1',   credEnv: 'AWS_PROFILE',                    stateScheme: 's3://' },
  azure: { region: 'eastus',      credEnv: 'AZURE_CLIENT_ID',                stateScheme: 'azblob://' },
}

export interface InitOptions {
  provider: SupportedProvider
  stackName?: string
  stateUrl?: string
  region?: string
  force?: boolean
  keyPath?: string
  /** local provider only */
  host?: string
  sshUser?: string
  sshPort?: number
}

export type InitResult =
  | {
      ok: true
      configPath: string
      stackName: string
      provider: SupportedProvider
      stateUrl: string
      region?: string
      keyPath: string
      /** False when an existing key was reused, which is the common case on a second run. */
      keyGenerated: boolean
    }
  | { ok: false; reason: string }

/**
 * Register a stack and write the config, or say why it cannot be written.
 *
 * Additive: a second stack does not replace the first. Overwriting an existing stack needs
 * `force`, because changing a stateUrl orphans the Pulumi state it points at — the
 * infrastructure stays up and clawops can no longer see or destroy it.
 */
export async function initStack(opts: InitOptions): Promise<InitResult> {
  const provider = opts.provider
  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    return {
      ok: false,
      reason: `Unsupported provider: ${provider}. Supported: ${SUPPORTED_PROVIDERS.join(', ')}`,
    }
  }

  const stackName = opts.stackName ?? 'default'
  const existing = getConfig()
  if (existing?.stacks[stackName] && !opts.force) {
    return {
      ok: false,
      reason:
        `Stack "${stackName}" already exists in ${path.join(getConfigDir(), 'config.json')} ` +
        `(${existing.stacks[stackName].stateUrl}). Pass force to overwrite its settings, or use ` +
        'a different stack name to add another one.',
    }
  }

  const configDir = getConfigDir()
  mkdirSync(configDir, { recursive: true })

  const keyPath = opts.keyPath ?? path.join(configDir, 'id_ed25519')
  const knownHostsPath = path.join(configDir, 'known_hosts')

  let keyGenerated = false
  if (!existsSync(keyPath)) {
    if (opts.keyPath) return { ok: false, reason: `SSH key not found at ${keyPath}` }
    /*
     * ssh-keygen, not crypto.generateKeyPairSync: the latter writes a PKCS#8 PEM that ssh2 —
     * which every clawops SSH operation uses — cannot parse, and OpenSSH rejects outright.
     */
    const gen = spawnSync(
      'ssh-keygen',
      ['-t', 'ed25519', '-f', keyPath, '-N', '', '-C', 'clawops', '-q'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    if (gen.error || gen.status !== 0) {
      const reason = gen.error?.message ?? gen.stderr?.toString().trim() ?? `exit ${gen.status}`
      return {
        ok: false,
        reason:
          `Could not generate an SSH key: ${reason}\n` +
          `Generate one yourself and point clawops at it:\n` +
          `  ssh-keygen -t ed25519 -f ${keyPath} -N '' -C clawops\n` +
          `  clawops init --key-path ${keyPath}`,
      }
    }
    keyGenerated = true
  }

  if (!existsSync(knownHostsPath)) writeFileSync(knownHostsPath, '', 'utf-8')

  if (provider === 'local') {
    if (!opts.host) return { ok: false, reason: 'host is required for the local provider' }
    const config = merge(existing, stackName, provider, keyPath, knownHostsPath, {
      provider,
      stateUrl: 'file://~/.clawops/state',
      credentialsRef: { source: 'file', envVars: [] },
      localOpts: {
        host: opts.host,
        sshUser: opts.sshUser ?? 'root',
        sshPort: opts.sshPort ?? 22,
        sshKeyPath: keyPath,
      },
    })
    setConfig(config)
    return {
      ok: true,
      configPath: path.join(configDir, 'config.json'),
      stackName,
      provider,
      stateUrl: 'file://~/.clawops/state',
      keyPath,
      keyGenerated,
    }
  }

  const defaults = PROVIDER_DEFAULTS[provider]
  const region = opts.region ?? defaults.region

  let stateUrl: string
  if (opts.stateUrl) {
    stateUrl = opts.stateUrl
  } else {
    // A name clawops chose beats a placeholder the operator has to notice.
    const account = await resolveScopeAccount(provider)
    const derived = deriveStateBucket(provider, { account, region })
    if (!derived.ok) {
      return {
        ok: false,
        reason:
          `Could not name a state backend for ${provider}: clawops needs ${derived.needs}. ` +
          'Authenticate first, or name the backend yourself, e.g. ' +
          `${defaults.stateScheme}your-bucket/clawops`,
      }
    }
    stateUrl = stateUrlFor(provider, derived.name)
  }

  setConfig(
    merge(existing, stackName, provider, keyPath, knownHostsPath, {
      provider,
      stateUrl,
      region,
      credentialsRef: { source: 'env', envVars: [defaults.credEnv] },
    }),
  )

  return {
    ok: true,
    configPath: path.join(configDir, 'config.json'),
    stackName,
    provider,
    stateUrl,
    region,
    keyPath,
    keyGenerated,
  }
}

/**
 * The new stack added to whatever was already there.
 *
 * Everything outside `stacks` survives: the MCP block, and the SSH paths unless this run
 * generated or was given a key. `defaults` moves to the stack just initialised — that is what
 * running init for it means.
 */
function merge(
  existing: ClawopsConfig | null,
  stackName: string,
  provider: SupportedProvider,
  keyPath: string,
  knownHostsPath: string,
  stack: ClawopsConfig['stacks'][string],
): ClawopsConfig {
  return {
    ...(existing ?? {}),
    version: 1,
    defaults: { stack: stackName, provider },
    stacks: { ...(existing?.stacks ?? {}), [stackName]: stack },
    ssh: { keyPath, knownHostsPath },
  }
}
