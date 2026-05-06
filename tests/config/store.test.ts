// Config store unit tests.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { getConfig, requireConfig, setConfig, getConfigDir } from '../../src/config/store.js'
import { withTempConfig, MINIMAL_CONFIG } from '../helpers/config.js'
import { UsageError, StateError } from '../../src/errors/index.js'

describe('getConfigDir()', () => {
  it('returns CLAWOPS_HOME when set', () => {
    const original = process.env['CLAWOPS_HOME']
    process.env['CLAWOPS_HOME'] = '/custom/path'
    try {
      expect(getConfigDir()).toBe('/custom/path')
    } finally {
      if (original === undefined) delete process.env['CLAWOPS_HOME']
      else process.env['CLAWOPS_HOME'] = original
    }
  })

  it('falls back to ~/.clawops', () => {
    const original = process.env['CLAWOPS_HOME']
    delete process.env['CLAWOPS_HOME']
    try {
      expect(getConfigDir()).toBe(path.join(os.homedir(), '.clawops'))
    } finally {
      if (original !== undefined) process.env['CLAWOPS_HOME'] = original
    }
  })
})

describe('getConfig()', () => {
  it('returns null when config file is missing', async () => {
    await withTempConfig({}, async (_tmpDir) => {
      // Write a valid config first, then the tmpDir will have one
      // We want to test the "missing" case — so use a fresh dir with no file
      const emptyDir = mkdtempSync(path.join(os.tmpdir(), 'clawops-empty-'))
      const prevHome = process.env['CLAWOPS_HOME']
      process.env['CLAWOPS_HOME'] = emptyDir
      try {
        expect(getConfig()).toBeNull()
      } finally {
        if (prevHome === undefined) delete process.env['CLAWOPS_HOME']
        else process.env['CLAWOPS_HOME'] = prevHome
        rmSync(emptyDir, { recursive: true, force: true })
      }
    })
  })

  it('returns parsed config when file exists', async () => {
    const result = await withTempConfig({}, async () => getConfig())
    expect(result).not.toBeNull()
    expect(result?.version).toBe(1)
    expect(result?.defaults.provider).toBe('gcp')
  })

  it('throws StateError for invalid config JSON', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'clawops-bad-'))
    const prevHome = process.env['CLAWOPS_HOME']
    process.env['CLAWOPS_HOME'] = tmpDir
    try {
      const { writeFileSync, mkdirSync } = await import('node:fs')
      mkdirSync(tmpDir, { recursive: true })
      writeFileSync(path.join(tmpDir, 'config.json'), '{ "version": 99 }', 'utf-8')
      expect(() => getConfig()).toThrow(StateError)
    } finally {
      if (prevHome === undefined) delete process.env['CLAWOPS_HOME']
      else process.env['CLAWOPS_HOME'] = prevHome
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('requireConfig()', () => {
  it('throws UsageError when config is missing', () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'clawops-req-'))
    const prevHome = process.env['CLAWOPS_HOME']
    process.env['CLAWOPS_HOME'] = tmpDir
    try {
      expect(() => requireConfig()).toThrow(UsageError)
      expect(() => requireConfig()).toThrow('clawops init')
    } finally {
      if (prevHome === undefined) delete process.env['CLAWOPS_HOME']
      else process.env['CLAWOPS_HOME'] = prevHome
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('returns config when file exists', async () => {
    const result = await withTempConfig({}, async () => requireConfig())
    expect(result.version).toBe(1)
  })
})

describe('setConfig() + getConfig() roundtrip', () => {
  let tmpDir: string
  let prevHome: string | undefined

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'clawops-rw-'))
    prevHome = process.env['CLAWOPS_HOME']
    process.env['CLAWOPS_HOME'] = tmpDir
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env['CLAWOPS_HOME']
    else process.env['CLAWOPS_HOME'] = prevHome
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('persists all fields', () => {
    setConfig(MINIMAL_CONFIG)
    const result = getConfig()
    expect(result).toMatchObject({
      version: 1,
      defaults: { stack: 'default', provider: 'gcp' },
    })
    expect(result?.stacks['default']?.stateUrl).toBe('gs://test-bucket/clawops')
  })

  it('atomic write: overwrites cleanly', () => {
    setConfig(MINIMAL_CONFIG)
    setConfig({ ...MINIMAL_CONFIG, defaults: { stack: 'prod', provider: 'gcp' } })
    expect(getConfig()?.defaults.stack).toBe('prod')
  })
})
