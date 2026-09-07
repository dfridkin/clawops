// The OpenClaw 2.0 config schema, captured from the pinned image.
//
// `openclaw config schema` does not emit a compilable document: it inlines each
// plugin's config schema into the parent without hoisting that plugin's `$defs` or
// rewriting the pointers inside it, so the refs are root-relative while the
// definitions sit several levels down. Verified on 2026.9.1 — 9 refs, 7 targets, no
// root `$defs`, and ajv refuses it outright.
//
// scripts/openclaw/normalise-schema.mjs rebases each ref onto the nearest ancestor
// that defines it. These tests hold that fix in place, because the failure mode is a
// schema that looks fine in a diff and throws the moment anything validates against it.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'

const schemaPath = resolve(import.meta.dirname, '../../spec/openclaw-2.0.config.schema.json')
const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as Record<string, unknown>

function compile() {
  const ajv = new Ajv({ strict: false, allErrors: true })
  addFormats(ajv)
  return ajv.compile(schema)
}

describe('openclaw 2.0 config schema', () => {
  it('compiles', () => {
    expect(() => compile()).not.toThrow()
  })

  it('has no ref that fails to resolve within the document', () => {
    const raw = readFileSync(schemaPath, 'utf8')
    const refs = [...raw.matchAll(/"\$ref"\s*:\s*"([^"]+)"/g)].map((m) => m[1]!)
    expect(refs.length, 'expected the plugin refs to still be present').toBeGreaterThan(0)

    const dangling = refs.filter((ref) => {
      if (!ref.startsWith('#/')) return true
      let cur: unknown = schema
      for (const seg of ref.slice(2).split('/')) {
        const key = seg.replace(/~1/g, '/').replace(/~0/g, '~')
        if (cur === null || typeof cur !== 'object' || !(key in (cur as object))) return true
        cur = (cur as Record<string, unknown>)[key]
      }
      return false
    })
    expect(dangling, `unresolvable: ${dangling.join(', ')}`).toEqual([])
  })

  it('rejects a config the gateway would reject', () => {
    const validate = compile()
    expect(validate({ gateway: { port: 'not-a-number' } })).toBe(false)
    expect(validate({ gateway: { mode: 'auto' } })).toBe(false) // 2.0 takes local|remote
  })

  it('accepts the config clawops writes', () => {
    const validate = compile()
    expect(
      validate({
        meta: { lastTouchedVersion: '2026.9' },
        gateway: { mode: 'local', port: 18789, auth: { mode: 'token' } },
        models: {},
        channels: {},
      }),
    ).toBe(true)
  })

  it('does not by itself prove the gateway will start', () => {
    // Schema validity is necessary, not sufficient — a config with no `gateway.mode`
    // passes both this schema and `openclaw config validate`, then exits 78 with
    // "Gateway start blocked: existing config is missing gateway.mode" unless
    // --allow-unconfigured is passed. Both observed on 2026.9.1.
    //
    // This test exists so nobody promotes the schema check into a startup guarantee.
    const validate = compile()
    expect(validate({ gateway: { port: 18789, auth: { mode: 'token' } } })).toBe(true)
  })
})
