// Validating a config against the schema captured from a pinned OpenClaw release.
//
// The interesting case is not "is this config valid" — ajv answers that. It is what to do
// when the schema and the runtime disagree, which they will: this line declares no version
// ceiling, so a deployment may run a newer OpenClaw than the schema was captured from.

import { describe, it, expect } from 'vitest'
import { validateConfig } from '../../src/openclaw/config-validate.js'

const VALID = {
  meta: { lastTouchedVersion: '2026.9.2' },
  gateway: { mode: 'local', port: 18789, auth: { mode: 'token' } },
  models: {},
  channels: {},
}

describe('validateConfig', () => {
  it('accepts the config clawops provisions', async () => {
    const r = await validateConfig(VALID)
    expect(r.errors).toEqual([])
    expect(r.warnings).toEqual([])
  })

  it('rejects a wrong type at any version', async () => {
    const r = await validateConfig({ ...VALID, gateway: { ...VALID.gateway, port: 'nope' } })
    expect(r.errors.join(' ')).toMatch(/gateway\.port/)
  })

  it('rejects a bad enum at any version', async () => {
    // "auto" was the plausible-looking guess; 2.0 takes local|remote.
    const r = await validateConfig({ ...VALID, gateway: { ...VALID.gateway, mode: 'auto' } })
    expect(r.errors.length).toBeGreaterThan(0)
  })

  it('catches what the hand-written validator could not', async () => {
    // The old validator had five rules and knew nothing of models.providers. A model entry
    // missing `name` passed it, and exited 78 on the gateway.
    const r = await validateConfig({
      ...VALID,
      models: { providers: { 'amazon-bedrock': { api: 'bedrock-converse-stream', models: [{ id: 'x' }] } } },
    })
    expect(r.errors.join(' ')).toMatch(/name/)
  })

  describe('when the runtime is newer than the captured schema', () => {
    const withFutureKey = { ...VALID, gateway: { ...VALID.gateway, someFutureSetting: true } }

    it('treats an unknown key as an error by default', async () => {
      // No version information: assume the config is wrong rather than the schema stale.
      const r = await validateConfig(withFutureKey)
      expect(r.errors.join(' ')).toMatch(/unknown key "someFutureSetting"/)
      expect(r.warnings).toEqual([])
    })

    it('demotes it to a warning when the deployed OpenClaw is newer', async () => {
      // Otherwise clawops refuses to write a config the runtime would accept — a worse
      // failure than not validating, because it blocks a legitimate operation.
      const r = await validateConfig(withFutureKey, {
        openclawVersion: '2026.12.1',
        schemaCapturedFrom: '2026.9.2',
      })
      expect(r.errors).toEqual([])
      expect(r.warnings.join(' ')).toMatch(/someFutureSetting/)
      expect(r.warnings.join(' ')).toMatch(/2026\.12\.1/)
    })

    it('still errors on an unknown key when the runtime is NOT newer', async () => {
      const r = await validateConfig(withFutureKey, {
        openclawVersion: '2026.9.2',
        schemaCapturedFrom: '2026.9.2',
      })
      expect(r.errors.join(' ')).toMatch(/someFutureSetting/)
    })

    it('never demotes a real error, however new the runtime', async () => {
      // A newer runtime explains an unknown KEY. It does not explain a string where an
      // integer belongs.
      const r = await validateConfig(
        { ...VALID, gateway: { ...VALID.gateway, port: 'nope' } },
        { openclawVersion: '2027.6.1', schemaCapturedFrom: '2026.9.2' },
      )
      expect(r.errors.length).toBeGreaterThan(0)
    })
  })
})

describe('atomicWriteConfig refuses an invalid config', () => {
  it('does not write, and keeps what was rejected', async () => {
    // The write is followed by a gateway restart. A config that fails validation is one
    // the gateway may refuse to start on — and by then the previous good config is gone.
    // So: validate first, keep the rejected content, leave the deployment untouched.
    const { FakeSshSession } = await import('../helpers/ssh.js')
    const { atomicWriteConfig } = await import('../../src/plan/remote-config.js')

    const cmds: string[] = []
    const session = new FakeSshSession()
    session.onExec(function handler(cmd: string) {
      cmds.push(cmd)
      session.onExec(handler)
      return { stdout: cmd.includes('uname') ? 'Linux' : '', stderr: '', code: 0 }
    })

    await expect(
      atomicWriteConfig(session as never, { gateway: { mode: 'auto' } }),
    ).rejects.toThrow(/Refusing to write an invalid OpenClaw config/)

    // The rejected content is preserved for inspection...
    expect(cmds.some((c) => c.includes('.rejected.'))).toBe(true)
    // ...and the live config is not touched. `mv` onto the real path is the commit step.
    expect(cmds.some((c) => /mv \S+ \S*openclaw\.json/.test(c))).toBe(false)
  })

  it('writes when the config is valid', async () => {
    const { FakeSshSession } = await import('../helpers/ssh.js')
    const { atomicWriteConfig } = await import('../../src/plan/remote-config.js')

    const cmds: string[] = []
    const session = new FakeSshSession()
    session.onExec(function handler(cmd: string) {
      cmds.push(cmd)
      session.onExec(handler)
      return { stdout: cmd.includes('uname') ? 'Linux' : '', stderr: '', code: 0 }
    })

    await atomicWriteConfig(session as never, {
      meta: { lastTouchedVersion: '2026.9.2' },
      gateway: { mode: 'local', port: 18789, auth: { mode: 'token' } },
    })
    expect(cmds.some((c) => /mv \S+ \S*openclaw\.json/.test(c))).toBe(true)
    expect(cmds.some((c) => c.includes('.rejected.'))).toBe(false)
  })
})

describe('clawops requirements the schema does not express', () => {
  it('requires gateway.mode, which the schema marks optional', async () => {
    // SP-10 measured this exactly: a config with no gateway.mode passes this schema AND
    // passes `openclaw config validate`, then exits 78 on startup. It is optional upstream
    // only because --allow-unconfigured can bypass the check — and WO-40 stopped passing
    // that flag, precisely so a clobbered config fails loudly. So the field is mandatory
    // for clawops even though OpenClaw calls it optional.
    //
    // Catching it here means the operator learns at write time, not from a crash-looping
    // container after the restart that follows the write.
    const r = await validateConfig({
      meta: { lastTouchedVersion: '2026.9.2' },
      gateway: { port: 18789, auth: { mode: 'token' } },
    })
    expect(r.errors.join(' ')).toMatch(/gateway\.mode: required by clawops/)
    expect(r.errors.join(' ')).toMatch(/exits 78/)
  })

  it('is not merely re-reporting a schema error', async () => {
    // Proof the schema really does accept it: strip the clawops rule and ajv is happy.
    const { default: Ajv } = await import('ajv')
    const { default: addFormats } = await import('ajv-formats')
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const schema = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../../spec/openclaw-2.0.config.schema.json'), 'utf8'),
    ) as object
    const ajv = new Ajv({ strict: false, allErrors: true })
    addFormats(ajv)
    expect(ajv.compile(schema)({ gateway: { port: 18789 } })).toBe(true)
  })
})
