import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

// spec/integrations.yaml drove the setup wizard for five releases with nothing checking it
// against OpenClaw's own schema. By 2.0 three of its five entries would have produced a
// config the gateway rejects or ignores:
//
//   - the Microsoft Teams key was `teams`; the schema calls it `msteams`
//   - Discord's token field was `botToken`; the property is `token`
//   - WhatsApp declared `phoneNumberId` and `accessToken`, neither of which exists on that
//     channel — its credentials live under `accounts.<name>`
//
// None of that is visible until a deployed gateway does not connect.

interface Field { name: string; sensitive: boolean; envDefault: string }
interface Integration {
  id: string
  channelKey: string
  fields: Field[]
  plugin?: { package: string; source: string; version?: string }
  requiredConfig?: string[]
  defaults?: Record<string, unknown>
  wizardSupported?: boolean
  useEnvSupported?: boolean
}

const root = process.cwd()
const catalog = (
  yaml.load(readFileSync(path.join(root, 'spec/integrations.yaml'), 'utf-8')) as {
    integrations: Integration[]
  }
).integrations

interface ChannelSchema {
  properties?: Record<string, unknown>
  required?: string[]
}
const schema = JSON.parse(
  readFileSync(path.join(root, 'spec/openclaw-2.0.config.schema.json'), 'utf-8'),
) as { properties: { channels: { properties: Record<string, ChannelSchema> } } }
const channels = schema.properties.channels.properties

const each = catalog.map((i) => [i.id, i] as const)

describe('spec/integrations.yaml matches the OpenClaw schema', () => {
  it.each(each)('%s names a channel the schema has', (_id, integ) => {
    expect(Object.keys(channels), `channelKey "${integ.channelKey}"`).toContain(integ.channelKey)
  })

  it.each(each)('%s only declares fields that channel actually has', (_id, integ) => {
    const props = Object.keys(channels[integ.channelKey]?.properties ?? {})
    const unknown = integ.fields.map((f) => f.name).filter((n) => !props.includes(n))
    expect(unknown, `${integ.id} declares fields the schema does not have`).toEqual([])
  })

  it.each(each)('%s records every key the schema requires', (_id, integ) => {
    // A channel written without these fails validation before it reaches the host, so the
    // wizard has to know about them.
    const required = channels[integ.channelKey]?.required ?? []
    for (const key of required) {
      expect(integ.requiredConfig ?? [], `${integ.id} is missing required key "${key}"`).toContain(key)
    }
  })

  it.each(each)('%s says which plugin provides it', (_id, integ) => {
    // Every channel in 2.0 is install-gated — `channels list --all --json` reports all 31 as
    // origin "installable". An entry with no plugin block would read as "nothing to install".
    expect(integ.plugin, `${integ.id} has no plugin block`).toBeDefined()
    expect(['npm', 'clawhub', 'bundled']).toContain(integ.plugin!.source)
    // Only a bundled channel may omit the package: it has nothing to download. Anything else
    // with an empty package would silently mean "nothing to install".
    if (integ.plugin!.source === 'bundled') {
      expect(integ.plugin!.package).toBe('')
    } else {
      expect(integ.plugin!.package, `${integ.id} plugin package`).not.toBe('')
      // Pinned, and not to a moving tag. @openclaw/discord@2026.9.3 refuses a 2026.9.2
      // runtime — "requires plugin API >=2026.9.3" — so `latest` breaks the deploy the
      // moment upstream publishes ahead of the floor, which it already has.
      expect(integ.plugin!.version, `${integ.id} plugin version`).toMatch(/^\d{4}\.\d+/)
    }
  })

  it('pins every channel plugin to the supported runtime floor', async () => {
    const yamlMod = (await import('js-yaml')).default
    const spec = yamlMod.load(
      readFileSync(path.join(root, 'spec/openclaw-versions.yaml'), 'utf-8'),
    ) as { support: { recommended: string } }

    for (const integ of catalog) {
      if (integ.plugin?.source === 'bundled' || !integ.plugin) continue
      expect(integ.plugin.version, `${integ.id} should pin to the runtime floor`)
        .toBe(spec.support.recommended)
    }
  })

  it.each(each)('%s uses the env var OpenClaw reads, not an invented one', (_id, integ) => {
    // Every envDefault was an `OPENCLAW_*` name that OpenClaw does not read — so the wizard
    // stored a secret under a variable nothing looked at, and the channel never
    // authenticated. The real names come from the binary: "Set these environment variables
    // before using --use-env: TELEGRAM_BOT_TOKEN."
    for (const f of integ.fields) {
      if (f.envDefault) {
        expect(f.envDefault, `${integ.id}.${f.name}`).not.toMatch(/^OPENCLAW_/)
      }
    }
  })

  it.each(each)('%s records whether --use-env works for it', (_id, integ) => {
    // WhatsApp and Microsoft Teams reject the flag outright: "OpenClaw does not recognize
    // option --use-env". Claiming otherwise sends an operator down a path that cannot work.
    expect(typeof integ.useEnvSupported, `${integ.id}.useEnvSupported`).toBe('boolean')
  })

  it('declares no env var for a channel with no non-interactive path', () => {
    for (const integ of catalog) {
      if (integ.useEnvSupported === false) {
        const named = integ.fields.filter((f) => f.envDefault).map((f) => f.name)
        expect(named, `${integ.id} has no --use-env path but names env vars`).toEqual([])
      }
    }
  })

  it('offers no channel whose credentials the wizard cannot collect', () => {
    // WhatsApp keeps credentials under `accounts.<name>`, so a flat token prompt writes a
    // config that looks complete and connects to nothing.
    for (const integ of catalog) {
      if (integ.wizardSupported === false) {
        expect(integ.fields, `${integ.id} is unsupported but still declares fields`).toEqual([])
      }
    }
  })

  it('pins what was actually measured against the image, per channel', () => {
    // Shape rules alone let a wrong value through: flipping WhatsApp to useEnvSupported:true
    // passes "is a boolean", and calling Discord bundled passes "bundled has no package".
    // These are the observed facts from OpenClaw 2026.9.2, named individually.
    const by = Object.fromEntries(catalog.map((i) => [i.id, i]))

    // `channels add --channel telegram --use-env` succeeds under --network none.
    expect(by['telegram']!.plugin!.source).toBe('bundled')
    expect(by['telegram']!.useEnvSupported).toBe(true)

    // These three install from npm as @openclaw/<channel>.
    for (const id of ['discord', 'slack', 'whatsapp', 'msteams']) {
      expect(by[id]!.plugin!.source, `${id} install source`).toBe('npm')
      expect(by[id]!.plugin!.package, `${id} package`).toBe(`@openclaw/${id}`)
    }

    // "OpenClaw does not recognize option \"--use-env\"" — there is no non-interactive path.
    expect(by['whatsapp']!.useEnvSupported).toBe(false)
    expect(by['msteams']!.useEnvSupported).toBe(false)

    // And these do have one.
    expect(by['discord']!.useEnvSupported).toBe(true)
    expect(by['slack']!.useEnvSupported).toBe(true)
  })

  it('never reintroduces the three keys that were wrong', () => {
    const ids = catalog.map((i) => i.channelKey)
    expect(ids).not.toContain('teams')
    const discord = catalog.find((i) => i.id === 'discord')!
    expect(discord.fields.map((f) => f.name)).toContain('token')
    expect(discord.fields.map((f) => f.name)).not.toContain('botToken')
    const whatsapp = catalog.find((i) => i.id === 'whatsapp')!
    expect(whatsapp.fields.map((f) => f.name)).not.toContain('phoneNumberId')
  })
})

describe('wizardChannels', () => {
  it('drops a channel the wizard cannot configure', async () => {
    const { wizardChannels } = await import('../../src/cli/commands/setup.js')
    const offered = wizardChannels(catalog as never).map((i: Integration) => i.id)
    expect(offered).not.toContain('whatsapp')
    expect(offered).toContain('discord')
  })

  it('treats a missing wizardSupported as supported', async () => {
    // The field marks the exception. Defaulting the other way would silently drop every
    // channel that simply did not mention it.
    const { wizardChannels } = await import('../../src/cli/commands/setup.js')
    const offered = wizardChannels([
      { id: 'a', channelKey: 'a', fields: [] },
      { id: 'b', channelKey: 'b', fields: [], wizardSupported: false },
      { id: 'c', channelKey: 'c', fields: [], wizardSupported: true },
    ] as never)
    expect(offered.map((i: Integration) => i.id)).toEqual(['a', 'c'])
  })
})

describe('what the wizard writes is a config OpenClaw accepts', () => {
  // The guard that would have caught all of this at once. Every channel the wizard wrote was
  // rejected by validation — Slack for six missing required properties, the rest for two —
  // and nothing noticed, because no test ever validated the wizard's own output.
  it.each(each)('%s produces a valid channels block', async (_id, integ) => {
    if (integ.wizardSupported === false) return

    // Built by the wizard's own function, not re-derived here — otherwise this validates the
    // catalog rather than what the wizard writes, and the wizard could stop writing defaults
    // entirely without failing.
    const { validateConfig } = await import('../../src/openclaw/config-validate.js')
    const { startChannelConfig } = await import('../../src/cli/commands/setup.js')
    const channelConfig = startChannelConfig(integ as never)
    for (const f of integ.fields) channelConfig[f.name] = f.sensitive ? '$secret:X' : 'value'

    const { errors } = await validateConfig(
      {
        meta: { lastTouchedVersion: '2026.9.2' },
        gateway: { mode: 'local', port: 18789, auth: { mode: 'token' } },
        models: {},
        channels: { [integ.channelKey]: channelConfig },
      },
      { schemaCapturedFrom: '2026.9.2' },
    )
    expect(errors, `${integ.id} config rejected`).toEqual([])
  })

  it('Slack is configured for Socket Mode, which needs no public webhook', () => {
    // The discrepancy this resolved: the catalog described the `http` webhook setup while
    // `channels add --use-env` installs Socket Mode. Socket Mode dials out to Slack, so
    // there is nothing to register and nothing to open.
    const slack = catalog.find((i) => i.id === 'slack')!
    expect(slack.defaults!['mode']).toBe('socket')
    expect((slack as unknown as { infraRequired: boolean }).infraRequired).toBe(false)

    const fields = slack.fields.map((f) => f.name)
    expect(fields).toContain('appToken')   // xapp-, what Socket Mode needs
    expect(fields).toContain('botToken')
    // And under the variable OpenClaw reads: "Slack Socket Mode requires SLACK_APP_TOKEN
    // when using --use-env." A field named appToken carrying the signing secret's variable
    // would look right and authenticate nothing.
    expect(slack.fields.find((f) => f.name === 'appToken')!.envDefault).toBe('SLACK_APP_TOKEN')
    expect(slack.fields.find((f) => f.name === 'botToken')!.envDefault).toBe('SLACK_BOT_TOKEN')
    // signingSecret verifies INBOUND requests; Socket Mode receives none.
    expect(fields).not.toContain('signingSecret')
  })

  it('every default is a value the schema actually allows', () => {
    for (const integ of catalog) {
      const props = (channels[integ.channelKey]?.properties ?? {}) as Record<
        string,
        { enum?: unknown[] }
      >
      for (const [key, value] of Object.entries(integ.defaults ?? {})) {
        expect(Object.keys(props), `${integ.id}.${key}`).toContain(key)
        const allowed = props[key]?.enum
        if (allowed) expect(allowed, `${integ.id}.${key}`).toContain(value)
      }
    }
  })
})
