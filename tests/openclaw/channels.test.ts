import { describe, it, expect } from 'vitest'
import {
  requiredChannelPlugins, channelInstallCommand, missingChannels, CHANNELS_LIST_CMD,
} from '../../src/openclaw/channels.js'

// Every channel in 2.0 is install-gated: `channels list --all --json` reports all 31 as
// origin "installable". A configured channel with no plugin gives a gateway that starts,
// reports healthy, and never connects — the WO-43 provider failure on the other half of the
// surface.

const CATALOG = {
  integrations: [
    { channelKey: 'discord', plugin: { package: '@openclaw/discord', source: 'npm', version: '2026.9.2' } },
    { channelKey: 'slack', plugin: { package: '@openclaw/slack', source: 'npm', version: '2026.9.2' } },
    { channelKey: 'telegram', plugin: { package: '', source: 'bundled' } },
  ],
}

const cfgWith = (...keys: string[]) => ({
  channels: Object.fromEntries(keys.map((k) => [k, { dmPolicy: 'pairing' }])),
})

describe('requiredChannelPlugins', () => {
  it('names the plugin for each configured channel', () => {
    expect(requiredChannelPlugins(cfgWith('discord'), CATALOG)).toEqual([
      { channelKey: 'discord', package: '@openclaw/discord', version: '2026.9.2' },
    ])
  })

  it('skips a bundled channel, which has nothing to fetch', () => {
    // telegram ships in the image: `channels add --channel telegram --use-env` succeeds
    // under --network none.
    expect(requiredChannelPlugins(cfgWith('telegram'), CATALOG)).toEqual([])
  })

  it('ignores channels the config does not name', () => {
    const needed = requiredChannelPlugins(cfgWith('discord'), CATALOG).map((p) => p.channelKey)
    expect(needed).not.toContain('slack')
  })

  it('ignores the settings blocks that live alongside channels', () => {
    // `channels.defaults` and `channels.modelByChannel` are settings, not channels. Treating
    // them as channels would look for a plugin that cannot exist.
    const cfg = { channels: { defaults: {}, modelByChannel: {}, discord: {} } }
    expect(requiredChannelPlugins(cfg, CATALOG).map((p) => p.channelKey)).toEqual(['discord'])
  })

  it.each([null, undefined, 42, {}, { channels: null }, { channels: 'x' }])(
    'returns nothing for %s rather than throwing',
    (cfg) => expect(requiredChannelPlugins(cfg, CATALOG)).toEqual([]),
  )
})

describe('channelInstallCommand', () => {
  it('installs the pinned version through plugins install', () => {
    // Not `channels add`: that installs and configures in one step and returns 0 whether or
    // not the install worked. `plugins install` exits 1, which is the point.
    const cmd = channelInstallCommand(
      { channelKey: 'discord', package: '@openclaw/discord', version: '2026.9.2' },
      'ghcr.io/openclaw/openclaw:2026.9.2',
      '/var/lib/clawops/openclaw',
    )
    expect(cmd).toContain("openclaw plugins install '@openclaw/discord@2026.9.2'")
    expect(cmd).toContain('--accept-capabilities')
    expect(cmd).not.toContain('channels add')
  })

  it('pins the version, because the newest plugin refuses the pinned runtime', () => {
    // Measured: @openclaw/discord@2026.9.3 answers "requires plugin API >=2026.9.3, but this
    // OpenClaw runtime exposes 2026.9.2" and installs nothing.
    const cmd = channelInstallCommand(
      { channelKey: 'discord', package: '@openclaw/discord', version: '2026.9.2' },
      'img', '/state',
    )
    expect(cmd).toContain('@2026.9.2')
    expect(cmd).not.toContain('latest')
  })

  it('mounts the state directory so the plugin lands where the gateway reads it', () => {
    const cmd = channelInstallCommand(
      { channelKey: 'slack', package: '@openclaw/slack', version: '2026.9.2' },
      'img', '/var/lib/clawops/openclaw',
    )
    expect(cmd).toContain('-v /var/lib/clawops/openclaw:/home/node/.openclaw')
  })
})

describe('missingChannels', () => {
  const listed = (state: Record<string, boolean>) =>
    JSON.stringify({
      chat: Object.fromEntries(Object.entries(state).map(([k, v]) => [k, { installed: v }])),
    })

  it('reports a configured channel that is not installed', () => {
    expect(missingChannels(cfgWith('discord'), listed({ discord: false }), CATALOG))
      .toEqual(['discord'])
  })

  it('reports nothing when it is installed', () => {
    expect(missingChannels(cfgWith('discord'), listed({ discord: true }), CATALOG)).toEqual([])
  })

  it('never reports a bundled channel as missing', () => {
    // telegram reports installed: false until an account is added. Counting that as missing
    // would fail a channel that has nothing to install and is working as designed.
    expect(missingChannels(cfgWith('telegram'), listed({ telegram: false }), CATALOG)).toEqual([])
  })

  it('reports every missing channel, not just the first', () => {
    expect(
      missingChannels(cfgWith('discord', 'slack'), listed({ discord: false, slack: false }), CATALOG),
    ).toEqual(['discord', 'slack'])
  })

  it('says nothing when the listing cannot be read', () => {
    // Unreadable output is a reporting problem. Claiming a channel is missing on the basis of
    // a parse failure would send someone chasing a working deployment.
    expect(missingChannels(cfgWith('discord'), 'not json', CATALOG)).toEqual([])
    expect(missingChannels(cfgWith('discord'), '', CATALOG)).toEqual([])
  })

  it('treats a channel with no installed field as not installed', () => {
    // `installed !== false` would count an entry that simply omits the field — and the
    // listing's shape is upstream's to change. Only an explicit true means installed.
    const listing = JSON.stringify({ chat: { discord: { origin: 'installable' } } })
    expect(missingChannels(cfgWith('discord'), listing, CATALOG)).toEqual(['discord'])
  })

  it('does not report the settings blocks that sit alongside channels', () => {
    // `channels.defaults` and `channels.modelByChannel` are settings. Counting them as
    // channels would report two permanently-missing "channels" on every deploy, and no
    // plugin could ever satisfy them.
    const cfg = { channels: { defaults: {}, modelByChannel: {}, discord: {} } }
    const listing = JSON.stringify({ chat: { discord: { installed: true } } })
    expect(missingChannels(cfg, listing, CATALOG)).toEqual([])
  })

  it('treats a channel absent from the listing as not installed', () => {
    expect(missingChannels(cfgWith('discord'), listed({ slack: true }), CATALOG))
      .toEqual(['discord'])
  })
})

describe('CHANNELS_LIST_CMD', () => {
  it('asks the gateway for the installed state of every channel', () => {
    expect(CHANNELS_LIST_CMD).toContain('channels list --all --json')
  })
})
