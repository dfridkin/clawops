// The handoff command is what the operator runs, so it has to be a real command: every flag one
// its CLI command declares, every argument surviving the shell intact, no secret in it.

import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  HANDOFF_ARGV_FOR_TESTS, SECRET_PLACEHOLDER, buildHandoff, pendingHandoffs, HANDOFF_TTL_MS,
} from '../../src/hostagent/handoff.js'
import { HANDOFF_TOOLS } from '../../src/hostagent/tools.js'

/** The CLI command and subcommand action each handoff tool maps to. */
const COMMAND: Record<string, { file: string; actions: string[] }> = {
  clawops_gateway_restart: { file: 'gateway', actions: ['restart'] },
  clawops_gateway_update: { file: 'gateway', actions: ['update'] },
  clawops_backup_restore: { file: 'backup', actions: ['restore'] },
  clawops_config_set: { file: 'config', actions: ['set'] },
  clawops_config_unset: { file: 'config', actions: ['unset'] },
  clawops_harden: { file: 'harden', actions: [] },
}

/** Every boolean and string input switched on, so every optional flag is emitted. */
const FULL_INPUT: Record<string, unknown> = {
  version: '2026.9.2', file: '/tmp/b.tgz', activate: true, key: 'agents.defaults.model',
  value: 'x', restart: true, options: 'ssh,ufw', dryRun: true, tailscale: true, tailscaleRevert: true,
}

/** What bash makes of a handoff command, minus the leading `clawops`. */
function shellWords(command: string): string[] {
  const rest = command.replace(/^clawops /, '')
  const out = spawnSync('/bin/bash', ['-c', `set -- ${rest}; printf '%s\\0' "$@"`], { encoding: 'utf-8' })
  expect(out.status).toBe(0)
  return out.stdout.split('\0').slice(0, -1)
}

describe('handoff commands', () => {
  it('has a command for every handoff tool, and no others', () => {
    expect(Object.keys(HANDOFF_ARGV_FOR_TESTS).sort()).toEqual([...HANDOFF_TOOLS].sort())
    expect(Object.keys(COMMAND).sort()).toEqual([...HANDOFF_TOOLS].sort())
  })

  it.each(HANDOFF_TOOLS)('%s names only flags its CLI command declares', async (tool) => {
    const { file, actions } = COMMAND[tool]!
    const mod = await import(`../../src/cli/commands/${file}.ts`)
    const declared = Object.keys(mod.default.args as Record<string, unknown>)
    const argv = HANDOFF_ARGV_FOR_TESTS[tool]!(FULL_INPUT, 'prod')

    expect(argv[0]).toBe(file)
    if (actions.length > 0) expect(actions).toContain(argv[1])
    const flags = argv.filter((w) => w.startsWith('--')).map((w) => w.slice(2))
    expect(flags.length).toBeGreaterThan(0)
    for (const flag of flags) expect(declared, `${tool}: --${flag}`).toContain(flag)
  })

  it('quotes arguments so the shell hands the CLI exactly what the call asked', () => {
    const value = `{"name":"it's a test","list":[1, 2]} $HOME \`id\``
    const h = buildHandoff('clawops_config_set', { key: 'agents.defaults.note', value }, 'prod')
    expect(shellWords(h.command)).toEqual(['config', 'set', 'agents.defaults.note', value, '--stack', 'prod'])
  })

  it('replaces a value at a secret path with a placeholder', () => {
    const h = buildHandoff('clawops_config_set', { key: 'channels.telegram.botToken', value: '123:ABC' }, 'prod')
    expect(h.command).toBe(`clawops config set channels.telegram.botToken ${SECRET_PLACEHOLDER} --stack prod`)
    expect(h.needsValue).toBe(true)
  })

  it('leaves the placeholder unquoted, so an unedited paste fails instead of setting "<value>"', () => {
    const h = buildHandoff('clawops_config_set', { key: 'models.providers.openai.apiKey', value: 'sk-1' }, 'prod')
    const out = spawnSync('/bin/bash', ['-c', `set -- ${h.command.replace(/^clawops /, '')}`], { encoding: 'utf-8' })
    expect(out.status).not.toBe(0)
  })
})

describe('pending handoffs', () => {
  it('drops lapsed and malformed entries', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'handoffs-'))
    const file = path.join(dir, 'handoffs.jsonl')
    const now = Date.parse('2026-10-16T12:00:00Z')
    const fresh = buildHandoff('clawops_gateway_restart', {}, 'prod', new Date(now - 1000))
    const old = buildHandoff('clawops_gateway_restart', {}, 'prod', new Date(now - HANDOFF_TTL_MS - 1000))
    writeFileSync(file, [JSON.stringify(old), 'not json', '{"x":1}', JSON.stringify(fresh), ''].join('\n'))
    expect(pendingHandoffs(file, now).map((h) => h.id)).toEqual([fresh.id])
    rmSync(dir, { recursive: true, force: true })
  })
})
