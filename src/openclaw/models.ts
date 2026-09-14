// Building the `models` block of an OpenClaw config.
//
// This is one place because it was previously nowhere: the setup wizard hand-built
// `{ provider, modelId }`, which is not a shape OpenClaw has. The schema's key is
// `models.providers.<id>`, and validation rejects the old one for EVERY provider:
//
//   models: unknown key "provider"
//   models: unknown key "modelId"
//
// The second-order failure was worse. `requiredPlugins` reads `models.providers` to decide
// which plugins to install, so with the wrong key it found nothing — and a configured
// provider whose plugin is missing exits the gateway 78 (SP-08 §2). One wrong key, two
// failures, neither visible without running it.
//
// See docs/spikes/SP-12-bedrock-config-shape.md.

export interface CatalogModel {
  id: string
  /** Provider-side identifier, when it differs from the catalog id. */
  modelId?: string
  displayName: string
}

export interface CatalogProvider {
  id: string
  /** Where this provider's block lives, e.g. `models.providers.amazon-bedrock`. */
  configPath?: string
  /**
   * Transport OpenClaw should use.
   *
   * Only set for providers that need it. Bundled providers resolve their own — `anthropic`
   * selects `anthropic-messages` with nothing in the config. A plugin provider does not:
   * Bedrock without this routes through the OpenAI-compatible transport and fails with
   * "requires an explicit base URL before using an OpenAI-compatible API".
   */
  api?: string
  credentialSource?: string
}

/**
 * The key this provider's block sits under.
 *
 * Taken from `configPath`, because the catalog id is not always OpenClaw's provider id —
 * `bedrock` in the catalog is `amazon-bedrock` to OpenClaw, and the plugin advertises
 * `providerIds: ["amazon-bedrock"]`. Keying by catalog id would write a block nothing reads.
 */
export function providerKeyOf(provider: CatalogProvider): string {
  const fromPath = provider.configPath?.split('.').pop()
  return fromPath && fromPath.length > 0 ? fromPath : provider.id
}

export interface BuildModelsOpts {
  provider: CatalogProvider
  model: CatalogModel
  /** Resolved provider-side model id — for Bedrock, an inference profile. */
  resolvedModelId?: string
  /** `$secret:NAME` reference, for api-key providers. */
  apiKeyRef?: string
  /** For providers reached over a URL, e.g. Ollama. */
  baseUrl?: string
  /** Deployment region, for providers that are region-scoped. */
  region?: string
}

/**
 * Build the `models` block for a single selected provider and model.
 *
 * The `models[]` array is not optional. Without it the provider contributes nothing to
 * `openclaw models list`, so there is no model to select and the deployment has no backend.
 */
export function buildModelsBlock(opts: BuildModelsOpts): Record<string, unknown> {
  const { provider, model, apiKeyRef, baseUrl, region } = opts
  const key = providerKeyOf(provider)
  const modelId = opts.resolvedModelId ?? model.modelId ?? model.id

  const entry: Record<string, unknown> = {}
  if (provider.api) entry['api'] = provider.api
  if (region) entry['region'] = region
  if (apiKeyRef) entry['apiKey'] = apiKeyRef
  if (baseUrl) entry['baseUrl'] = baseUrl
  if (provider.credentialSource === 'aws-profile') {
    // Not load-bearing — credentials resolve through the AWS SDK chain at call time, and
    // Bedrock was reached with this absent (SP-12 §4). Written because it is one key that
    // says out loud which auth route the provider uses.
    entry['auth'] = 'aws-sdk'
  }

  entry['models'] = [
    {
      id: modelId,
      name: model.displayName,
      ...(provider.api ? { api: provider.api } : {}),
    },
  ]

  return { providers: { [key]: entry } }
}
