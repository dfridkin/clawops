// Test helper: withTempConfig — writes a valid config to a temp dir,
// sets CLAWOPS_HOME, runs the callback, then restores the env variable.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { setConfig } from '../../src/config/store.js'
import type { ClawopsConfig } from '../../src/config/store.js'

export const MINIMAL_CONFIG: ClawopsConfig = {
  version: 1,
  defaults: { stack: 'default', provider: 'gcp' },
  stacks: {
    default: {
      provider: 'gcp',
      stateUrl: 'gs://test-bucket/clawops',
      region: 'us-central1',
      credentialsRef: { source: 'env', envVars: ['GOOGLE_APPLICATION_CREDENTIALS'] },
    },
  },
  ssh: {
    keyPath: '/tmp/test-id_ed25519',
    knownHostsPath: '/tmp/test-known_hosts',
  },
}

/**
 * Run a test with a temporary clawops config directory.
 * Automatically restores CLAWOPS_HOME and cleans up the temp dir.
 */
export async function withTempConfig<T>(
  overrides: Partial<ClawopsConfig>,
  fn: (tmpDir: string) => T | Promise<T>,
): Promise<T>
export async function withTempConfig<T>(
  fn: (tmpDir: string) => T | Promise<T>,
): Promise<T>
export async function withTempConfig<T>(
  overridesOrFn: Partial<ClawopsConfig> | ((tmpDir: string) => T | Promise<T>),
  fn?: (tmpDir: string) => T | Promise<T>,
): Promise<T> {
  const overrides = typeof overridesOrFn === 'function' ? {} : overridesOrFn
  const callback = typeof overridesOrFn === 'function' ? overridesOrFn : fn!

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'clawops-test-'))
  const prevHome = process.env['CLAWOPS_HOME']

  try {
    process.env['CLAWOPS_HOME'] = tmpDir
    const config: ClawopsConfig = { ...MINIMAL_CONFIG, ...overrides }
    setConfig(config)
    return await callback(tmpDir)
  } finally {
    if (prevHome === undefined) {
      delete process.env['CLAWOPS_HOME']
    } else {
      process.env['CLAWOPS_HOME'] = prevHome
    }
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}
