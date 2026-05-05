// Provider registry — maps provider names to adapter implementations.
// Populated as adapters are added in M1–M4.

import type { ProviderAdapter, ProviderName } from './types'

const registry = new Map<ProviderName, ProviderAdapter>()

export function registerProvider(adapter: ProviderAdapter): void {
  registry.set(adapter.name, adapter)
}

export function getProvider(name: ProviderName): ProviderAdapter {
  const adapter = registry.get(name)
  if (!adapter) {
    throw new Error(
      `No provider adapter registered for '${name}'. ` +
        'Run `clawops init` to configure a provider.',
    )
  }
  return adapter
}

export function listProviders(): ProviderName[] {
  return Array.from(registry.keys())
}
