// ClawopsContext — built once per CLI invocation; passed to command handlers.
// Holds resolved config, provider adapter, and a lazy Pulumi stack singleton.
// Per Issue 14 (perf): LocalWorkspace is created at most once per process.

import type { Stack } from '@pulumi/pulumi/automation'
import { requireConfig, getConfigDir, type ClawopsConfig } from '../config/store.js'
import type { ProviderAdapter, ProviderName } from '../providers/types.js'
import { readLocalState, type LocalState } from '../providers/local/state.js'
import { UsageError } from '../errors/index.js'

export interface ClawopsContext {
  config: ClawopsConfig
  adapter: ProviderAdapter
  stackName: string
  /**
   * For local stacks: persisted state from ~/.clawops/state/<stack>.json,
   * or null if not yet bootstrapped. Undefined for cloud-backed stacks.
   */
  localState?: LocalState | null
  /** Lazily create/select the Pulumi stack. Throws for local provider. */
  getStack(): Promise<Stack>
}

export interface ContextArgs {
  stack?: string | boolean
  provider?: string | boolean
  [key: string]: unknown
}

/**
 * Build a ClawopsContext from parsed CLI args.
 * Synchronously reads config; Pulumi workspace is created lazily via getStack().
 */
export function buildContext(args: ContextArgs): ClawopsContext {
  const config = requireConfig()

  const stackName =
    typeof args.stack === 'string' ? args.stack : config.defaults.stack

  const providerName =
    typeof args.provider === 'string'
      ? args.provider
      : (config.stacks[stackName]?.provider ?? config.defaults.provider)

  const adapter = loadProvider(providerName as ProviderName)

  // For local stacks, load persisted connection state from disk (synchronous).
  // Returns null when the host has not been bootstrapped yet.
  const localState: LocalState | null | undefined =
    providerName === 'local' ? readLocalState(stackName) : undefined

  let stackCache: Stack | null = null

  return {
    config,
    adapter,
    stackName,
    localState,
    async getStack() {
      if (providerName === 'local') {
        throw new UsageError(
          'The local provider does not use Pulumi stacks. ' +
            'Use `clawops up` to bootstrap the host instead.',
        )
      }

      if (stackCache) return stackCache

      const stackConfig = config.stacks[stackName]
      if (!stackConfig) {
        throw new UsageError(
          `Stack "${stackName}" not found in config. ` +
            'Run `clawops init` or use `--stack` to specify a different stack.',
        )
      }

      // Lazy import keeps pulumi out of the module graph for commands that don't need it
      const { getOrCreateStack } = await import('../pulumi/automation.js')
      stackCache = await getOrCreateStack({
        stack: stackName,
        stateUrl: stackConfig.stateUrl,
        program: adapter.program,
        configDir: getConfigDir(),
      })
      return stackCache
    },
  }
}

function loadProvider(name: ProviderName): ProviderAdapter {
  return makeProviderProxy(name)
}

function makeProviderProxy(name: ProviderName): ProviderAdapter {
  let resolved: ProviderAdapter | null = null

  const resolve = async (): Promise<ProviderAdapter> => {
    if (resolved) return resolved
    switch (name) {
      case 'gcp': {
        const mod = await import('../providers/gcp/index.js')
        resolved = mod.default
        return resolved
      }
      case 'aws': {
        const mod = await import('../providers/aws/index.js')
        resolved = mod.default
        return resolved
      }
      case 'azure': {
        const mod = await import('../providers/azure/index.js')
        resolved = mod.default
        return resolved
      }
      case 'local': {
        const mod = await import('../providers/local/index.js')
        resolved = mod.default
        return resolved
      }
      default:
        throw new UsageError(
          `Provider "${name}" is not yet supported. Supported providers: gcp, aws, azure, local`,
        )
    }
  }

  // Return a synchronous-looking adapter that lazily loads on first async call
  return {
    name,
    get program() {
      return async () => {
        const adapter = await resolve()
        return adapter.program()
      }
    },
    getConnectionInfo: (outputs) => {
      if (!resolved) throw new UsageError('Provider not yet loaded. Call getStack() first.')
      return resolved.getConnectionInfo(outputs)
    },
    normalizeInstanceType: (alias) => {
      if (!resolved) throw new UsageError('Provider not yet loaded. Call getStack() first.')
      return resolved.normalizeInstanceType(alias)
    },
    defaultRegion: () => {
      if (!resolved) throw new UsageError('Provider not yet loaded. Call getStack() first.')
      return resolved.defaultRegion()
    },
    stateBackendUrl: (bucket) => {
      if (!resolved) throw new UsageError('Provider not yet loaded. Call getStack() first.')
      return resolved.stateBackendUrl(bucket)
    },
    validateConfig: () => resolve().then((a) => a.validateConfig()),
  }
}
