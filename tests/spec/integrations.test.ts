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
  plugin?: { package: string; source: string }
  requiredConfig?: string[]
  wizardSupported?: boolean
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
    expect(['npm', 'clawhub', 'unknown']).toContain(integ.plugin!.source)
    if (integ.plugin!.source !== 'unknown') {
      expect(integ.plugin!.package, `${integ.id} plugin package`).not.toBe('')
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
