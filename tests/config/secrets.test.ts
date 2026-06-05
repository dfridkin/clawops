import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

vi.mock('../../src/config/store.js', () => ({
  getConfigDir: vi.fn(() => path.join(tmpdir(), `clawops-secrets-test-${randomUUID()}`)),
}))

import { resolveSecretRef, resolveSecretsInConfig, secretsDir } from '../../src/config/secrets.js'

function makeSecretsDir(): string {
  const dir = path.join(tmpdir(), `clawops-secrets-${randomUUID()}`)
  mkdirSync(path.join(dir, 'secrets'), { recursive: true })
  return dir
}

function writeSecret(configDir: string, name: string, value: string): void {
  writeFileSync(path.join(configDir, 'secrets', name), value + '\n', { mode: 0o600 })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('secretsDir()', () => {
  it('returns path under the config dir', () => {
    const dir = secretsDir('/tmp/clawops-test')
    expect(dir).toBe('/tmp/clawops-test/secrets')
  })
})

describe('resolveSecretRef()', () => {
  it('returns the file contents (trimmed) when the secret exists', () => {
    const configDir = makeSecretsDir()
    writeSecret(configDir, 'MY_TOKEN', 'abc123')
    expect(resolveSecretRef('MY_TOKEN', configDir)).toBe('abc123')
  })

  it('returns null when the secret file does not exist', () => {
    const configDir = makeSecretsDir()
    expect(resolveSecretRef('NONEXISTENT', configDir)).toBeNull()
  })
})

describe('resolveSecretsInConfig()', () => {
  it('replaces $secret:NAME with file contents', () => {
    const configDir = makeSecretsDir()
    writeSecret(configDir, 'DISCORD_TOKEN', 'tok-xyz')

    const result = resolveSecretsInConfig(
      { channels: { discord: { botToken: '$secret:DISCORD_TOKEN' } } },
      configDir,
    )
    expect((result as { channels: { discord: { botToken: string } } }).channels.discord.botToken).toBe('tok-xyz')
  })

  it('leaves unresolvable refs in place and emits a warning', () => {
    const configDir = makeSecretsDir()
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const result = resolveSecretsInConfig({ token: '$secret:MISSING' }, configDir)
    expect((result as { token: string }).token).toBe('$secret:MISSING')
    expect(stderrSpy).toHaveBeenCalledOnce()
    expect(String(stderrSpy.mock.calls[0]![0])).toContain('MISSING')

    stderrSpy.mockRestore()
  })

  it('passes through non-secret strings unchanged', () => {
    const configDir = makeSecretsDir()
    const result = resolveSecretsInConfig({ model: 'claude-sonnet-4-6' }, configDir)
    expect((result as { model: string }).model).toBe('claude-sonnet-4-6')
  })

  it('walks arrays', () => {
    const configDir = makeSecretsDir()
    writeSecret(configDir, 'KEY_A', 'val-a')
    const result = resolveSecretsInConfig(['$secret:KEY_A', 'plain'], configDir)
    expect(result).toEqual(['val-a', 'plain'])
  })

  it('returns non-object scalars unchanged', () => {
    const configDir = makeSecretsDir()
    expect(resolveSecretsInConfig(42, configDir)).toBe(42)
    expect(resolveSecretsInConfig(true, configDir)).toBe(true)
    expect(resolveSecretsInConfig(null, configDir)).toBeNull()
  })
})
