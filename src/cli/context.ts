// ClawopsContext — built once per CLI invocation; passed to command handlers.
// Holds resolved config, provider adapter, and a lazy Pulumi stack singleton.
// Per Issue 14 (perf): LocalWorkspace is created at most once per process.

import type { Stack } from '@pulumi/pulumi/automation/index.js'
import { requireConfig, getConfigDir, type ClawopsConfig } from '../config/store.js'
import type { ProviderAdapter, ProviderName } from '../providers/types.js'
import { readLocalState, type LocalState } from '../providers/local/state.js'
import { UsageError } from '../errors/index.js'
import { getProvider } from '../providers/index.js'
import '../providers/register.js'

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

  /** Set once a tailnet address has been verified for this stack; see TailscaleOverride. */
  const tailscale = config.stacks[stackName]?.tailscale

  const adapter = tailscale
    ? viaTailscale(loadProvider(providerName as ProviderName), tailscale.ip)
    : loadProvider(providerName as ProviderName)

  // For local stacks, load persisted connection state from disk (synchronous).
  // Returns null when the host has not been bootstrapped yet.
  const persisted: LocalState | null | undefined =
    providerName === 'local' ? readLocalState(stackName) : undefined
  /*
   * The same override for local stacks, which never reach getConnectionInfo: they build their
   * connections from `ctx.localState.sshHost` directly, in six places. Rewriting it here is what
   * makes the tailnet address apply to a local box at all; without it an override was ignored and
   * `--private-only` on a local stack would have locked the operator out.
   */
  const localState: LocalState | null | undefined =
    persisted && tailscale ? { ...persisted, sshHost: tailscale.ip } : persisted

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
 * The adapter, reaching the host over its tailnet address instead of the public one.
 *
 * Nineteen call sites build a connection with `ctx.adapter.getConnectionInfo`, and every one of
 * them has to follow the stack onto the tailnet or `--private-only` locks the operator out of
 * logs, ssh, tunnel, harden and apply at once. Wrapping the adapter here means none of them
 * change and none of them can be missed. Only the host moves: user, port and the key paths are
 * the machine's, not the network's.
 */
function viaTailscale(adapter: ProviderAdapter, ip: string): ProviderAdapter {
  const wrapped = Object.create(adapter) as ProviderAdapter
  wrapped.getConnectionInfo = (outputs) => ({ ...adapter.getConnectionInfo(outputs), host: ip })
  return wrapped
}

/**
 * The real adapter for a provider.
 *
 * This used to hand back a proxy that loaded the module on its first *async* call, so every
 * synchronous method on it — `getConnectionInfo`, `normalizeInstanceType`, `defaultRegion` —
 * threw "Provider not yet loaded. Call getStack() first." until something else had happened to
 * load it. Eighteen call sites depended on that ordering and nothing enforced it: `clawops up`
 * worked because it awaits `validateConfig()` first, `clawops plan` did not, and `doctor
 * --stack`, `ssh`, `logs` and `gateway restart` all failed against a running instance with an
 * error about provider loading.
 *
 * The adapters are registered eagerly instead (see ../providers/register.js). They are small,
 * and the Pulumi packages they eventually need are imported inside the program function rather
 * than at module scope, so this costs a few milliseconds and removes the failure mode.
 */
function loadProvider(name: ProviderName): ProviderAdapter {
  try {
    return getProvider(name)
  } catch {
    throw new UsageError(
      `Provider "${name}" is not yet supported. Supported providers: gcp, aws, azure, local`,
    )
  }
}

/**
 * Kept for callers that resolve an adapter without building a context. Now that adapters are
 * registered at import, this is the same lookup; it stays async because its callers await it
 * and because a future adapter may genuinely need loading.
 */
export async function loadAdapterModule(name: ProviderName): Promise<ProviderAdapter> {
  return loadProvider(name)
}

