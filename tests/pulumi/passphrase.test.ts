import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import process from 'node:process'
import { tmpdir } from 'node:os'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import {
  ensurePassphrase, passphrasePath, passphraseStatus, passphraseInEnvironment,
} from '../../src/pulumi/passphrase.js'

let dir: string
const saved: Record<string, string | undefined> = {}
const VARS = ['PULUMI_CONFIG_PASSPHRASE', 'PULUMI_CONFIG_PASSPHRASE_FILE'] as const

beforeEach(() => {
  for (const v of VARS) {
    saved[v] = process.env[v]
    delete process.env[v]
  }
  dir = mkdtempSync(path.join(tmpdir(), 'clawops-pass-'))
})
afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v]
    else process.env[v] = saved[v]
  }
  rmSync(dir, { recursive: true, force: true })
})

describe('passphrasePath', () => {
  it('sits with the other clawops secrets', () => {
    expect(passphrasePath('/home/u/.clawops')).toBe('/home/u/.clawops/secrets/pulumi-passphrase')
  })
})

describe('ensurePassphrase', () => {
  it('generates one and writes it before returning', () => {
    const value = ensurePassphrase(dir)
    // A passphrase that encrypted a stack and was never persisted takes that stack's secrets
    // with it, so it must be on disk by the time anyone can use it.
    expect(readFileSync(passphrasePath(dir), 'utf-8').trim()).toBe(value)
  })

  it('generates something long enough to be a key, not a word', () => {
    expect(ensurePassphrase(dir)!.length).toBeGreaterThanOrEqual(32)
  })

  it('generates a different one per machine', () => {
    const other = mkdtempSync(path.join(tmpdir(), 'clawops-pass-'))
    try {
      expect(ensurePassphrase(dir)).not.toBe(ensurePassphrase(other))
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('returns the same value on every later call', () => {
    // Rotating it would orphan every stack already encrypted with the old one.
    const first = ensurePassphrase(dir)
    expect(ensurePassphrase(dir)).toBe(first)
  })

  it('keeps the file private to the user', () => {
    ensurePassphrase(dir)
    expect(statSync(passphrasePath(dir)).mode & 0o777).toBe(0o600)
  })

  it('replaces an empty file rather than encrypting with the empty string', () => {
    mkdirSync(path.dirname(passphrasePath(dir)), { recursive: true })
    writeFileSync(passphrasePath(dir), '   \n')
    const value = ensurePassphrase(dir)
    expect(value).toBeTruthy()
    expect(value!.trim()).toBe(value)
  })

  it('yields to PULUMI_CONFIG_PASSPHRASE and writes nothing', () => {
    process.env['PULUMI_CONFIG_PASSPHRASE'] = 'theirs'
    expect(ensurePassphrase(dir)).toBeUndefined()
    expect(() => readFileSync(passphrasePath(dir), 'utf-8')).toThrow()
  })

  it('yields to PULUMI_CONFIG_PASSPHRASE_FILE too', () => {
    process.env['PULUMI_CONFIG_PASSPHRASE_FILE'] = '/somewhere/else'
    expect(ensurePassphrase(dir)).toBeUndefined()
  })
})

describe('passphraseStatus', () => {
  it('reports the environment when the operator set one', () => {
    process.env['PULUMI_CONFIG_PASSPHRASE'] = 'theirs'
    expect(passphraseStatus(dir)).toBe('environment')
    expect(passphraseInEnvironment()).toBe(true)
  })

  it('reports absent before anything has been generated', () => {
    expect(passphraseStatus(dir)).toBe('absent')
  })

  it('reports stored afterwards', () => {
    ensurePassphrase(dir)
    expect(passphraseStatus(dir)).toBe('stored')
  })

  it('creates nothing — doctor must not change what it measures', () => {
    passphraseStatus(dir)
    expect(() => readFileSync(passphrasePath(dir), 'utf-8')).toThrow()
  })
})
