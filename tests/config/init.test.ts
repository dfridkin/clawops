// Registering a stack: the decisions `clawops init` and clawops_init both make.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

let home: string
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'clawops-init-'))
  vi.stubEnv('CLAWOPS_HOME', home)
  vi.resetModules()
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

const read = () => JSON.parse(readFileSync(path.join(home, 'config.json'), 'utf-8'))

describe('initStack', () => {
  it('writes a config and generates a key on a machine that has none', async () => {
    const { initStack } = await import('../../src/config/init.js')
    const result = await initStack({ provider: 'aws', stateUrl: 's3://b/clawops', stackName: 'sandbox' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.keyGenerated).toBe(true)
    expect(existsSync(result.keyPath)).toBe(true)
    expect(read().stacks.sandbox.stateUrl).toBe('s3://b/clawops')
  })

  /*
   * A second stack used to replace the first, taking its stateUrl with it — the only pointer to
   * where that stack's infrastructure is recorded. The infrastructure stays up; clawops can no
   * longer see or destroy it.
   */
  it('adds a second stack without disturbing the first', async () => {
    const { initStack } = await import('../../src/config/init.js')
    await initStack({ provider: 'aws', stateUrl: 's3://one/clawops', stackName: 'one' })
    await initStack({ provider: 'gcp', stateUrl: 'gs://two/clawops', stackName: 'two' })
    const cfg = read()
    expect(Object.keys(cfg.stacks).sort()).toEqual(['one', 'two'])
    expect(cfg.stacks.one.stateUrl).toBe('s3://one/clawops')
  })

  it('refuses to overwrite an existing stack without force', async () => {
    const { initStack } = await import('../../src/config/init.js')
    await initStack({ provider: 'aws', stateUrl: 's3://one/clawops', stackName: 'one' })
    const again = await initStack({ provider: 'aws', stateUrl: 's3://other/clawops', stackName: 'one' })
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.reason).toMatch(/already exists/)
    expect(read().stacks.one.stateUrl).toBe('s3://one/clawops')
  })

  it('overwrites when force is given, which is the operator saying they meant it', async () => {
    const { initStack } = await import('../../src/config/init.js')
    await initStack({ provider: 'aws', stateUrl: 's3://one/clawops', stackName: 'one' })
    const again = await initStack({ provider: 'aws', stateUrl: 's3://other/clawops', stackName: 'one', force: true })
    expect(again.ok).toBe(true)
    expect(read().stacks.one.stateUrl).toBe('s3://other/clawops')
  })

  it('reuses a key that is already there rather than replacing it', async () => {
    const { initStack } = await import('../../src/config/init.js')
    const first = await initStack({ provider: 'aws', stateUrl: 's3://b/c', stackName: 'one' })
    const second = await initStack({ provider: 'aws', stateUrl: 's3://b/c', stackName: 'two' })
    expect(second.ok).toBe(true)
    if (!second.ok || !first.ok) return
    expect(second.keyGenerated).toBe(false)
    expect(second.keyPath).toBe(first.keyPath)
  })

  it('needs a host for the local provider, and says so', async () => {
    const { initStack } = await import('../../src/config/init.js')
    const result = await initStack({ provider: 'local' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/host is required/)
  })
})
