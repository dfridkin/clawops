// Unit tests for the `init` command.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { getConfig } from '../../src/config/store.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRunFn = (ctx: any) => Promise<void>

async function getCmd() {
  const { default: cmd } = await import('../../src/cli/commands/init.js')
  return cmd
}


describe('init command — cloud providers', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('creates config with gcp defaults when no args given', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'clawops-init-test-'))
    const prevHome = process.env['CLAWOPS_HOME']
    process.env['CLAWOPS_HOME'] = tmpDir
    try {
      vi.resetModules()
      const cmd = await getCmd()
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      await (cmd.run as AnyRunFn)({ args: { provider: 'gcp', 'non-interactive': true } })
      vi.restoreAllMocks()

      process.env['CLAWOPS_HOME'] = tmpDir
      const cfg = getConfig()
      expect(cfg?.stacks['default']?.provider).toBe('gcp')
      expect(cfg?.stacks['default']?.region).toBe('us-central1')
      expect(cfg?.stacks['default']?.credentialsRef.source).toBe('env')
    } finally {
      if (prevHome === undefined) delete process.env['CLAWOPS_HOME']
      else process.env['CLAWOPS_HOME'] = prevHome
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('uses --state URL verbatim', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'clawops-init-test-'))
    const prevHome = process.env['CLAWOPS_HOME']
    process.env['CLAWOPS_HOME'] = tmpDir
    try {
      vi.resetModules()
      const cmd = await getCmd()
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      await (cmd.run as AnyRunFn)({
        args: { provider: 'aws', state: 's3://my-real-bucket/clawops', 'non-interactive': true },
      })
      vi.restoreAllMocks()

      process.env['CLAWOPS_HOME'] = tmpDir
      const cfg = getConfig()
      expect(cfg?.stacks['default']?.stateUrl).toBe('s3://my-real-bucket/clawops')
    } finally {
      if (prevHome === undefined) delete process.env['CLAWOPS_HOME']
      else process.env['CLAWOPS_HOME'] = prevHome
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('uses --stack name for the stack key and default', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'clawops-init-test-'))
    const prevHome = process.env['CLAWOPS_HOME']
    process.env['CLAWOPS_HOME'] = tmpDir
    try {
      vi.resetModules()
      const cmd = await getCmd()
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      await (cmd.run as AnyRunFn)({
        args: { provider: 'gcp', stack: 'prod', 'non-interactive': true },
      })
      vi.restoreAllMocks()

      process.env['CLAWOPS_HOME'] = tmpDir
      const cfg = getConfig()
      expect(cfg?.defaults.stack).toBe('prod')
      expect(cfg?.stacks['prod']).toBeDefined()
    } finally {
      if (prevHome === undefined) delete process.env['CLAWOPS_HOME']
      else process.env['CLAWOPS_HOME'] = prevHome
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('reuses an existing SSH key when present (file content unchanged)', async () => {
    const { readFileSync } = await import('node:fs')
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'clawops-init-test-'))
    const prevHome = process.env['CLAWOPS_HOME']
    process.env['CLAWOPS_HOME'] = tmpDir
    const keyPath = path.join(tmpDir, 'id_ed25519')
    // Pre-create the key file so generation is skipped
    writeFileSync(keyPath, 'FAKE_KEY_CONTENT', { mode: 0o600 })
    try {
      vi.resetModules()
      const cmd = await getCmd()
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      await (cmd.run as AnyRunFn)({
        args: { provider: 'gcp', 'non-interactive': true },
      })
      vi.restoreAllMocks()

      // Content should be unchanged — we did NOT regenerate the key
      const content = readFileSync(keyPath, 'utf-8')
      expect(content).toBe('FAKE_KEY_CONTENT')
    } finally {
      if (prevHome === undefined) delete process.env['CLAWOPS_HOME']
      else process.env['CLAWOPS_HOME'] = prevHome
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('--non-interactive without --provider throws UsageError', async () => {
    vi.resetModules()
    const cmd = await getCmd()
    const { UsageError } = await import('../../src/errors/index.js')
    await expect(
      (cmd.run as AnyRunFn)({ args: { 'non-interactive': true } }),
    ).rejects.toBeInstanceOf(UsageError)
  })

  it('unsupported provider throws UsageError', async () => {
    vi.resetModules()
    const cmd = await getCmd()
    const { UsageError } = await import('../../src/errors/index.js')
    await expect(
      (cmd.run as AnyRunFn)({ args: { provider: 'digitalocean', 'non-interactive': true } }),
    ).rejects.toBeInstanceOf(UsageError)
  })
})

describe('init command — local provider', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('writes localOpts with correct defaults', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'clawops-init-test-'))
    const prevHome = process.env['CLAWOPS_HOME']
    process.env['CLAWOPS_HOME'] = tmpDir
    try {
      vi.resetModules()
      const cmd = await getCmd()
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      await (cmd.run as AnyRunFn)({
        args: { provider: 'local', host: '192.168.1.10', 'non-interactive': true },
      })
      vi.restoreAllMocks()

      process.env['CLAWOPS_HOME'] = tmpDir
      const cfg = getConfig()
      const opts = cfg?.stacks['default']?.localOpts
      expect(opts?.host).toBe('192.168.1.10')
      expect(opts?.sshUser).toBe('root')
      expect(opts?.sshPort).toBe(22)
    } finally {
      if (prevHome === undefined) delete process.env['CLAWOPS_HOME']
      else process.env['CLAWOPS_HOME'] = prevHome
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('respects --ssh-user and --ssh-port overrides', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'clawops-init-test-'))
    const prevHome = process.env['CLAWOPS_HOME']
    process.env['CLAWOPS_HOME'] = tmpDir
    try {
      vi.resetModules()
      const cmd = await getCmd()
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      await (cmd.run as AnyRunFn)({
        args: {
          provider: 'local',
          host: '10.0.0.5',
          'ssh-user': 'ubuntu',
          'ssh-port': '2222',
          'non-interactive': true,
        },
      })
      vi.restoreAllMocks()

      process.env['CLAWOPS_HOME'] = tmpDir
      const cfg = getConfig()
      const opts = cfg?.stacks['default']?.localOpts
      expect(opts?.sshUser).toBe('ubuntu')
      expect(opts?.sshPort).toBe(2222)
    } finally {
      if (prevHome === undefined) delete process.env['CLAWOPS_HOME']
      else process.env['CLAWOPS_HOME'] = prevHome
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('throws UsageError when --host is missing', async () => {
    vi.resetModules()
    const cmd = await getCmd()
    const { UsageError } = await import('../../src/errors/index.js')
    await expect(
      (cmd.run as AnyRunFn)({ args: { provider: 'local', 'non-interactive': true } }),
    ).rejects.toBeInstanceOf(UsageError)
  })

  it('writes stateUrl as file:// scheme', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'clawops-init-test-'))
    const prevHome = process.env['CLAWOPS_HOME']
    process.env['CLAWOPS_HOME'] = tmpDir
    try {
      vi.resetModules()
      const cmd = await getCmd()
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      await (cmd.run as AnyRunFn)({
        args: { provider: 'local', host: '10.0.0.1', 'non-interactive': true },
      })
      vi.restoreAllMocks()

      process.env['CLAWOPS_HOME'] = tmpDir
      const cfg = getConfig()
      expect(cfg?.stacks['default']?.stateUrl).toMatch(/^file:\/\//)
    } finally {
      if (prevHome === undefined) delete process.env['CLAWOPS_HOME']
      else process.env['CLAWOPS_HOME'] = prevHome
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
