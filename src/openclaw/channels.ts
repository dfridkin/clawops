// Channel plugins: which ones a config needs, and whether they actually installed.
//
// The model-provider story from WO-43, on the other half of the surface. Every channel in
// OpenClaw 2.0 is install-gated — `openclaw channels list --all --json` reports all 31 as
// `origin: "installable"` and none as bundled-and-ready — so a configured channel with no
// plugin gives a gateway that starts, reports healthy, and never connects.
//
// Two things make this different from the provider case, both measured on 2026.9.2:
//
//   - channel plugins come from npm as `@openclaw/<channelKey>`, not from ClawHub
//   - `openclaw channels add` EXITS 0 when the plugin install fails. It prints the error,
//     says "Returning to selection", and returns success. So clawops installs with
//     `openclaw plugins install`, which exits 1 properly, and verifies against
//     `channels list` rather than trusting any exit code.

export interface ChannelPlugin {
  /** Key under `channels` in the OpenClaw config, e.g. `discord`. */
  channelKey: string
  /** npm package. */
  package: string
  /** Pinned — see the note in spec/integrations.yaml for why this is not `latest`. */
  version: string
}

interface CatalogChannel {
  channelKey: string
  plugin?: { package: string; source: string; version?: string }
}

/**
 * Which channel plugins the config's `channels` block requires.
 *
 * Driven by the config rather than a plan field, for the same reason as providers: the
 * config already says which channels a deployment uses, and a parallel list would be a
 * second source of truth to reconcile.
 *
 * Bundled channels are skipped — telegram ships in the image and has no package to fetch.
 */
export function requiredChannelPlugins(
  cfg: unknown,
  catalog: { integrations: CatalogChannel[] },
): ChannelPlugin[] {
  const configured = configuredChannelKeys(cfg)
  const out: ChannelPlugin[] = []
  for (const entry of catalog.integrations) {
    const plugin = entry.plugin
    if (!plugin || plugin.source === 'bundled' || !plugin.package) continue
    if (configured.has(entry.channelKey)) {
      out.push({
        channelKey: entry.channelKey,
        package: plugin.package,
        version: plugin.version ?? '',
      })
    }
  }
  return out
}

/**
 * The install command, pinned.
 *
 * `openclaw plugins install`, not `channels add`: the latter installs and configures in one
 * step but returns 0 whether or not the install worked. This exits 1, which is the whole
 * reason to use it.
 */
export function channelInstallCommand(
  plugin: ChannelPlugin,
  image: string,
  stateDir: string,
): string {
  const spec = plugin.version ? `${plugin.package}@${plugin.version}` : plugin.package
  return (
    `docker run --rm -v ${stateDir}:/home/node/.openclaw ${image} ` +
    `openclaw plugins install '${spec}' --accept-capabilities`
  )
}

/** Reads the installed state of every channel. */
export const CHANNELS_LIST_CMD = 'docker exec openclaw openclaw channels list --all --json'

/**
 * Reconcile what the config asked for against what is actually installed.
 *
 * Asserts `installed: true` from the gateway rather than trusting an exit code, because the
 * command that would normally report this lies about it.
 *
 * Bundled channels are excluded: telegram reports `installed: false` until an account is
 * added, so counting it as missing would report a failure for a channel that has nothing to
 * install and is working as designed.
 */
export function missingChannels(
  cfg: unknown,
  channelsListJson: string,
  catalog: { integrations: CatalogChannel[] },
): string[] {
  let installed: Set<string>
  try {
    const parsed = JSON.parse(channelsListJson) as {
      chat?: Record<string, { installed?: boolean }>
    }
    const chat = parsed.chat ?? {}
    installed = new Set(
      Object.entries(chat)
        .filter(([, v]) => v.installed === true)
        .map(([k]) => k),
    )
  } catch {
    return [] // unreadable output is a reporting problem, not a missing channel
  }

  const bundled = new Set(
    catalog.integrations
      .filter((i) => i.plugin?.source === 'bundled')
      .map((i) => i.channelKey),
  )

  return [...configuredChannelKeys(cfg)].filter((k) => !installed.has(k) && !bundled.has(k))
}

function configuredChannelKeys(cfg: unknown): Set<string> {
  if (cfg === null || typeof cfg !== 'object') return new Set()
  const channels = (cfg as Record<string, unknown>)['channels']
  if (channels === null || typeof channels !== 'object') return new Set()
  // `defaults` and `modelByChannel` are settings blocks, not channels.
  const notAChannel = new Set(['defaults', 'modelByChannel'])
  return new Set(Object.keys(channels as Record<string, unknown>).filter((k) => !notAChannel.has(k)))
}
