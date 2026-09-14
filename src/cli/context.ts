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

/**
 * The real adapter for a provider.
 *
 * `buildContext().adapter` is a proxy whose synchronous methods — `normalizeInstanceType`,
 * `defaultRegion`, `getConnectionInfo` — throw until something async has loaded the module
 * behind it. `clawops up` gets away with calling them because it happens to `await
 * validateConfig()` first; `generatePlan` did not, and a deploy died at plan time with
 * "Provider not yet loaded. Call getStack() first." Anything that needs a synchronous adapter
 * method without needing a stack awaits this instead of depending on call order.
 */
export async function loadAdapterModule(name: ProviderName): Promise<ProviderAdapter> {
  switch (name) {
    case 'gcp':
      return (await import('../providers/gcp/index.js')).default
    case 'aws':
      return (await import('../providers/aws/index.js')).default
    case 'azure':
      return (await import('../providers/azure/index.js')).default
    case 'local':
      return (await import('../providers/local/index.js')).default
    default:
      throw new UsageError(
        `Provider "${name}" is not yet supported. Supported providers: gcp, aws, azure, local`,
      )
  }
}

const NOT_LOADED =
  'Provider not yet loaded. Await `getStack()`, or `loadAdapterModule(provider)` when no stack ' +
  'is needed, before calling this.'

function loadProvider(name: ProviderName): ProviderAdapter {
  return makeProviderProxy(name)
}

function makeProviderProxy(name: ProviderName): ProviderAdapter {
  let resolved: ProviderAdapter | null = null

  const resolve = async (): Promise<ProviderAdapter> => {
    if (resolved) return resolved
    resolved = await loadAdapterModule(name)
    return resolved
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
      if (!resolved) throw new UsageError(NOT_LOADED)
      return resolved.getConnectionInfo(outputs)
    },
    normalizeInstanceType: (alias) => {
      if (!resolved) throw new UsageError(NOT_LOADED)
      return resolved.normalizeInstanceType(alias)
    },
    defaultRegion: () => {
      if (!resolved) throw new UsageError(NOT_LOADED)
      return resolved.defaultRegion()
    },
    stateBackendUrl: (bucket) => {
      if (!resolved) throw new UsageError(NOT_LOADED)
      return resolved.stateBackendUrl(bucket)
    },
    validateConfig: () => resolve().then((a) => a.validateConfig()),
  }
}
