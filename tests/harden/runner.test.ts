// Unit tests for the hardening runner and module resolution logic.

import { describe, it, expect, vi } from 'vitest'
import { resolveModules, formatHardenSummary } from '../../src/harden/runner.js'
import type { HardeningModule, ModuleRunResult } from '../../src/harden/types.js'

function makeModule(
  id: string,
  opts: Partial<Pick<HardeningModule, 'defaultOn' | 'providers'>> = {},
): HardeningModule {
  return {
    id,
    label: `Module ${id}`,
    defaultOn: opts.defaultOn ?? true,
    providers: opts.providers ?? 'all',
    check: vi.fn().mockResolvedValue({ status: 'missing', detail: 'not applied' }),
    apply: vi.fn().mockResolvedValue({ changed: true, detail: 'applied' }),
  }
}

describe('resolveModules()', () => {
  const catalog: HardeningModule[] = [
    makeModule('ssh'),
    makeModule('ufw'),
    makeModule('fail2ban'),
    makeModule('auditd', { defaultOn: false }),
    makeModule('aws-sg-audit', { defaultOn: true, providers: ['aws'] }),
    makeModule('aws-guardduty', { defaultOn: false, providers: ['aws'] }),
  ]

  it('returns defaultOn modules for the provider when options is empty', () => {
    const mods = resolveModules(catalog, undefined, 'aws')
    const ids = mods.map((m) => m.id)
    expect(ids).toContain('ssh')
    expect(ids).toContain('ufw')
    expect(ids).toContain('fail2ban')
    expect(ids).toContain('aws-sg-audit')
    expect(ids).not.toContain('auditd')
    expect(ids).not.toContain('aws-guardduty')
  })

  it('filters out aws-specific modules for non-aws providers', () => {
    const mods = resolveModules(catalog, undefined, 'local')
    const ids = mods.map((m) => m.id)
    expect(ids).not.toContain('aws-sg-audit')
    expect(ids).not.toContain('aws-guardduty')
    expect(ids).toContain('ssh')
  })

  it('selects specific modules by --options CSV', () => {
    const mods = resolveModules(catalog, 'ssh,auditd', 'aws')
    expect(mods.map((m) => m.id)).toEqual(['ssh', 'auditd'])
  })

  it('--options can select opt-in modules not in defaultOn set', () => {
    const mods = resolveModules(catalog, 'aws-guardduty', 'aws')
    expect(mods[0]?.id).toBe('aws-guardduty')
  })

  it('ignores unknown module IDs in --options', () => {
    const mods = resolveModules(catalog, 'ssh,nonexistent', 'aws')
    expect(mods.map((m) => m.id)).toEqual(['ssh'])
  })

  it('returns empty array when options selects provider-filtered modules for wrong provider', () => {
    const mods = resolveModules(catalog, 'aws-sg-audit', 'local')
    expect(mods).toHaveLength(0)
  })
})

describe('formatHardenSummary()', () => {
  function makeResult(
    id: string,
    opts: { changed?: boolean; status?: string; error?: string },
  ): ModuleRunResult {
    return {
      module: makeModule(id),
      checkResult: { status: (opts.status ?? 'missing') as 'applied' | 'missing' | 'drifted' | 'skipped', detail: 'detail' },
      applyResult: opts.changed !== undefined ? { changed: opts.changed, detail: 'done' } : undefined,
      durationMs: 100,
      error: opts.error,
    }
  }

  it('includes module label in output', () => {
    const output = formatHardenSummary([makeResult('ssh', { changed: true })])
    expect(output).toContain('Module ssh')
  })

  it('shows ✓ for applied changes', () => {
    const output = formatHardenSummary([makeResult('ssh', { changed: true })])
    expect(output).toContain('✓')
  })

  it('shows · for already-ok modules', () => {
    const output = formatHardenSummary([makeResult('ssh', { changed: false, status: 'applied' })])
    expect(output).toContain('·')
  })

  it('shows ✗ for errored modules', () => {
    const output = formatHardenSummary([makeResult('ssh', { error: 'connection refused' })])
    expect(output).toContain('✗')
    expect(output).toContain('error')
  })

  it('includes summary line with counts', () => {
    const results = [
      makeResult('ssh', { changed: true }),
      makeResult('ufw', { changed: false, status: 'applied' }),
      makeResult('fail2ban', { error: 'failed' }),
    ]
    const output = formatHardenSummary(results)
    expect(output).toContain('1 applied')
    expect(output).toContain('1 already ok')
    expect(output).toContain('1 errors')
  })
})
