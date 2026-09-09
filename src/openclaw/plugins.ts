// Provider plugins: which ones a config needs, and whether they actually loaded.
//
// OpenClaw 2.0 does not bundle every model provider. Of the six clawops offers, three ship
// in the image (openai, anthropic, ollama) and three do not (deepseek, kimi, bedrock).
//
// A configured-but-missing provider does not fail loudly. Measured on 2026.9.2:
//
//   egress available  → the gateway installs it mid-boot, then exits 1 for a convergence
//                       restart, refetching on every container replacement
//   egress denied     → the gateway starts HEALTHY, without the provider
//
// clawops defaults to deny-all egress, so the silent case is the default one: a green
// deployment whose model backend is absent. Installing at deploy time, when egress exists,
// removes both outcomes. See docs/spikes/SP-10-openclaw-2.0-startup-contract.md §SP-10b.

export interface ProviderPlugin {
  /** OpenClaw provider id, as it appears under `models.providers` and in `providerIds`. */
  providerId: string
  /** ClawHub package. */
  package: string
  /** Pinned version — see the note in spec/models.yaml for why this is not `latest`. */
  version: string
}

interface CatalogProvider {
  id: string
  configPath?: string
  plugin?: { package: string; version: string }
}

/** The provider id OpenClaw uses, which is not always the catalog's own id (bedrock). */
function providerIdOf(p: CatalogProvider): string {
  return p.configPath?.split('.').pop() ?? p.id
}

/**
 * Which plugins must be installed for the providers this config names.
 *
 * Driven by `models.providers` rather than a plan field: OpenClaw's config already says
 * which providers a deployment uses, and a parallel list in the plan would be a second
 * source of truth to reconcile.
 */
export function requiredPlugins(
  cfg: unknown,
  catalog: { providers: CatalogProvider[] },
): ProviderPlugin[] {
  if (cfg === null || typeof cfg !== 'object') return []
  const models = (cfg as Record<string, unknown>)['models']
  if (models === null || typeof models !== 'object') return []
  const providers = (models as Record<string, unknown>)['providers']
  if (providers === null || typeof providers !== 'object') return []

  const configured = new Set(Object.keys(providers as Record<string, unknown>))
  const out: ProviderPlugin[] = []
  for (const entry of catalog.providers) {
    if (!entry.plugin) continue // bundled in the image
    const id = providerIdOf(entry)
    if (configured.has(id)) {
      out.push({ providerId: id, package: entry.plugin.package, version: entry.plugin.version })
    }
  }
  return out
}

/** The install command for a plugin, pinned. */
export function installCommand(plugin: ProviderPlugin, image: string, stateDir: string): string {
  // --accept-capabilities: an install prompts for the plugin's declared capabilities, and
  // provisioning has no terminal to answer on. Pinned packages from ClawHub's official
  // namespace, chosen by clawops rather than by arbitrary user input.
  return (
    `docker run --rm -v ${stateDir}:/home/node/.openclaw ${image} ` +
    `openclaw plugins install 'clawhub:${plugin.package}@${plugin.version}' --accept-capabilities`
  )
}

/**
 * Reconcile what the config asked for against what the gateway actually loaded.
 *
 * Matches on `providerIds`, NOT plugin id: the `google` plugin serves `google`,
 * `google-gemini-cli` and `google-vertex`, so an id-to-id comparison reports false
 * failures. `openclaw plugins doctor` is deliberately not used — it never names a missing
 * provider and exits 1 on duplicate-id warnings during normal operation, so it fails when
 * nothing is wrong and stays quiet when something is.
 */
export function missingProviders(cfg: unknown, pluginsListJson: string): string[] {
  let loaded = new Set<string>()
  try {
    const parsed = JSON.parse(pluginsListJson) as
      | { plugins?: Array<{ enabled?: boolean; status?: string; providerIds?: string[] }> }
      | Array<{ enabled?: boolean; status?: string; providerIds?: string[] }>
    const list = Array.isArray(parsed) ? parsed : (parsed.plugins ?? [])
    loaded = new Set(
      list
        .filter((p) => p.enabled !== false && p.status !== 'error')
        .flatMap((p) => p.providerIds ?? []),
    )
  } catch {
    return [] // unreadable output is a reporting problem, not a missing provider
  }

  if (cfg === null || typeof cfg !== 'object') return []
  const models = (cfg as Record<string, unknown>)['models']
  if (models === null || typeof models !== 'object') return []
  const providers = (models as Record<string, unknown>)['providers']
  if (providers === null || typeof providers !== 'object') return []

  return Object.keys(providers as Record<string, unknown>).filter((id) => !loaded.has(id))
}
