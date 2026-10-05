// clawops_secret_list, clawops_secret_audit, clawops_secret_delete.
//
// These run against a real temporary ~/.clawops (HOME points at a temp dir), not mocked fs:
// the properties that matter — no value ever returned, nothing outside the secrets directory
// ever deleted — are properties of the files, and a mock could satisfy them by not existing.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { handleSecretList, handleSecretAudit, handleSecretDelete } from '../../src/mcp/tools/cli/secret.js'

const KNOWN_VALUE = 'sk-live-THIS-VALUE-MUST-NEVER-APPEAR-9f3a71'

let home: string
let savedHome: string | undefined
let savedClawopsHome: string | undefined

function clawopsDir(): string { return path.join(home, '.clawops') }
function secretsDir(): string { return path.join(clawopsDir(), 'secrets') }

function writeSecret(name: string, value: string): void {
  mkdirSync(secretsDir(), { recursive: true })
  writeFileSync(path.join(secretsDir(), name), value, { mode: 0o600 })
}

function writeOverlay(stackName: string, secrets: Array<{ name: string; source: string; ref?: string }>): void {
  const dir = path.join(clawopsDir(), 'overlays')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, `${stackName}.json`),
    JSON.stringify({ stackName, savedAt: '2026-10-03T00:00:00Z', overlay: {}, secrets }),
  )
}

/** A server whose client can elicit; `elicitInput` records what the human was asked. */
function elicitingServer(action: 'accept' | 'decline' = 'accept', confirmed = true) {
  const elicitInput = vi.fn().mockResolvedValue({ action, content: { confirmed } })
  const server = {
    server: { getClientCapabilities: () => ({ elicitation: {} }), elicitInput },
  } as unknown as McpServer
  return { server, elicitInput }
}

/** A server whose client never declared elicitation. */
function nonElicitingServer(): McpServer {
  return {
    server: { getClientCapabilities: () => ({}), elicitInput: vi.fn() },
  } as unknown as McpServer
}

function text(r: { content?: unknown[] }): string {
  return (r.content ?? []).map((c) => String((c as { text?: unknown }).text ?? '')).join('\n')
}

/** Everything the CLI printed, through whichever channel it used. */
function cliOutput(): string {
  const parts = [
    ...vi.mocked(process.stdout.write).mock.calls.map((c) => String(c[0])),
    ...vi.mocked(console.log).mock.calls.map((c) => c.join(' ')),
    ...vi.mocked(console.warn).mock.calls.map((c) => c.join(' ')),
    ...vi.mocked(console.error).mock.calls.map((c) => c.join(' ')),
  ]
  // Strip ANSI colour so the comparison is about words.
  return parts.join('\n').replace(/\u001b\[[0-9;]*m/g, '')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- citty's run context is loosely typed
type RunFn = (ctx: any) => Promise<void> | void
async function cliSubcommand(name: string): Promise<RunFn> {
  const { default: cmd } = await import('../../src/cli/commands/secret.js')
  return (cmd.subCommands as Record<string, { run: RunFn }>)[name]!.run
}

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'clawops-secret-mcp-'))
  savedHome = process.env['HOME']
  savedClawopsHome = process.env['CLAWOPS_HOME']
  process.env['HOME'] = home
  process.env['CLAWOPS_HOME'] = clawopsDir()

  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => { throw new Error(`exit:${code}`) })
})

afterEach(() => {
  vi.restoreAllMocks()
  if (savedHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = savedHome
  if (savedClawopsHome === undefined) delete process.env['CLAWOPS_HOME']
  else process.env['CLAWOPS_HOME'] = savedClawopsHome
  rmSync(home, { recursive: true, force: true })
})

// ── list ───────────────────────────────────────────────────────────────────

describe('clawops_secret_list', () => {
  it('lists the secret by name and status, and the value appears nowhere in the result', async () => {
    writeSecret('ANTHROPIC_API_KEY', KNOWN_VALUE)
    const result = await handleSecretList({}, elicitingServer().server)

    expect(result.isError).toBeFalsy()
    const out = text(result)
    // Positive: the secret really was found, so absence of the value is not absence of output.
    const parsed = JSON.parse(out) as { secrets: Array<{ name: string; status: string }> }
    expect(parsed.secrets).toEqual([expect.objectContaining({ name: 'ANTHROPIC_API_KEY', status: 'ok' })])
    // The property itself, over the whole serialised result.
    expect(JSON.stringify(result)).not.toContain(KNOWN_VALUE)
    expect(JSON.stringify(result)).not.toContain(KNOWN_VALUE.slice(0, 12))
  })

  it('does not write anything to stdout (R15)', async () => {
    writeSecret('A', KNOWN_VALUE)
    await handleSecretList({}, elicitingServer().server)
    await handleSecretAudit({}, elicitingServer().server)
    expect(process.stdout.write).not.toHaveBeenCalled()
    expect(console.log).not.toHaveBeenCalled()
  })
})

// ── audit ──────────────────────────────────────────────────────────────────

describe('clawops_secret_audit', () => {
  it('reports a secret a stack references but clawops does not have', async () => {
    writeOverlay('prod', [{ name: 'MISSING_KEY', source: 'file' }])
    const result = await handleSecretAudit({}, elicitingServer().server)

    const parsed = JSON.parse(text(result)) as { ok: boolean; issues: Array<{ kind: string; stack?: string; secret: string }> }
    expect(parsed.ok).toBe(false)
    expect(parsed.issues).toContainEqual(expect.objectContaining({ kind: 'missing-file', stack: 'prod', secret: 'MISSING_KEY' }))
  })

  it('never includes a value, even for a reference that does resolve', async () => {
    writeSecret('PRESENT', KNOWN_VALUE)
    writeSecret('EMPTY', '   ')
    writeOverlay('prod', [{ name: 'PRESENT', source: 'file' }, { name: 'EMPTY', source: 'file' }])
    const result = await handleSecretAudit({}, elicitingServer().server)
    const parsed = JSON.parse(text(result)) as { issues: Array<{ kind: string; secret: string }> }
    expect(parsed.issues).toContainEqual(expect.objectContaining({ kind: 'empty-secret', secret: 'EMPTY' }))
    expect(JSON.stringify(result)).not.toContain(KNOWN_VALUE)
  })
})

// ── delete ─────────────────────────────────────────────────────────────────

describe('clawops_secret_delete', () => {
  it('asks for confirmation without yes, and deletes only once the human accepts', async () => {
    writeSecret('OLD_KEY', KNOWN_VALUE)
    const { server, elicitInput } = elicitingServer('accept', true)

    const result = await handleSecretDelete({ name: 'OLD_KEY', yes: false }, server)

    expect(elicitInput).toHaveBeenCalledOnce()
    expect(result.isError).toBeFalsy()
    expect((JSON.parse(text(result)) as { message: string }).message).toBe('Secret "OLD_KEY" deleted.')
    expect(existsSync(path.join(secretsDir(), 'OLD_KEY'))).toBe(false)
  })

  it('deletes nothing when the human declines', async () => {
    writeSecret('OLD_KEY', KNOWN_VALUE)
    const { server } = elicitingServer('decline', false)

    const result = await handleSecretDelete({ name: 'OLD_KEY', yes: false }, server)

    expect(text(result)).toMatch(/Nothing was changed/)
    expect(existsSync(path.join(secretsDir(), 'OLD_KEY'))).toBe(true)
  })

  it('a client without elicitation gets "call again with yes: true", and nothing is deleted', async () => {
    writeSecret('OLD_KEY', KNOWN_VALUE)

    const result = await handleSecretDelete({ name: 'OLD_KEY', yes: false }, nonElicitingServer())

    expect(text(result)).toMatch(/yes: true/)
    expect(text(result)).toContain('deleting secret "OLD_KEY"')
    expect(existsSync(path.join(secretsDir(), 'OLD_KEY'))).toBe(true)
  })

  it('with yes: true, deletes without asking', async () => {
    writeSecret('OLD_KEY', KNOWN_VALUE)
    const { server, elicitInput } = elicitingServer()

    const result = await handleSecretDelete({ name: 'OLD_KEY', yes: true }, server)

    expect(elicitInput).not.toHaveBeenCalled()
    expect(existsSync(path.join(secretsDir(), 'OLD_KEY'))).toBe(false)
    expect(JSON.stringify(result)).not.toContain(KNOWN_VALUE)
  })

  it('refuses a secret that does not exist, in the CLI\'s words', async () => {
    mkdirSync(secretsDir(), { recursive: true })
    const expected = `Secret "NOPE" not found at ${path.join(secretsDir(), 'NOPE')}`

    const result = await handleSecretDelete({ name: 'NOPE', yes: true }, elicitingServer().server)
    expect(result.isError).toBe(true)
    expect(text(result)).toBe(expected)

    const run = await cliSubcommand('delete')
    await expect(run({ args: { _: ['NOPE'], yes: true } })).rejects.toThrow('exit:1')
    expect(cliOutput()).toContain(expected)
  })

  it('puts the "still referenced by" warning in the confirmation and the result, in the CLI\'s words', async () => {
    writeSecret('SHARED_KEY', KNOWN_VALUE)
    writeOverlay('prod', [{ name: 'SHARED_KEY', source: 'file' }])
    writeOverlay('staging', [{ name: 'SHARED_KEY', source: 'file' }])
    writeOverlay('dev', [{ name: 'OTHER', source: 'file' }])
    const { server, elicitInput } = elicitingServer('accept', true)

    const result = await handleSecretDelete({ name: 'SHARED_KEY', yes: false }, server)

    const asked = String((elicitInput.mock.calls[0]?.[0] as { message?: unknown } | undefined)?.message ?? '')
    expect(asked).toMatch(/Secret "SHARED_KEY" is referenced by stack\(s\): (prod, staging|staging, prod)/)
    expect(asked).not.toContain('dev')
    const parsed = JSON.parse(text(result)) as { referencingStacks: string[]; warnings: string[] }
    expect([...parsed.referencingStacks].sort()).toEqual(['prod', 'staging'])
    expect(parsed.warnings.join('\n')).toContain('unresolvable $secret: ref')

    // The CLI prints the same lines.
    writeSecret('SHARED_KEY', KNOWN_VALUE)
    const run = await cliSubcommand('delete')
    await run({ args: { _: ['SHARED_KEY'], yes: true } })
    for (const line of parsed.warnings) expect(cliOutput()).toContain(line)
  })

  it.each(['../victim', '../../victim', 'sub/../../victim', '..', '.'])(
    'refuses the path-traversal name %j on both surfaces, and the file outside survives',
    async (name) => {
      writeSecret('KEEP', KNOWN_VALUE)
      const victim = path.join(clawopsDir(), 'victim')
      const victim2 = path.join(home, 'victim')
      writeFileSync(victim, 'outside-the-secrets-dir')
      writeFileSync(victim2, 'outside-the-secrets-dir')

      const result = await handleSecretDelete({ name, yes: true }, elicitingServer().server)
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('is not valid')

      const run = await cliSubcommand('delete')
      await expect(run({ args: { _: [name], yes: true } })).rejects.toThrow('exit:2')
      expect(cliOutput()).toContain(text(result))

      expect(existsSync(victim)).toBe(true)
      expect(existsSync(victim2)).toBe(true)
      expect(readdirSync(secretsDir())).toEqual(['KEEP'])
    },
  )

  it('the CLI refuses a traversal name on set too, and writes nothing outside the secrets dir', async () => {
    const run = await cliSubcommand('set')
    await expect(run({ args: { _: ['../config.json'], value: 'x' } })).rejects.toThrow('exit:2')
    expect(existsSync(path.join(clawopsDir(), 'config.json'))).toBe(false)
  })

  it('the audit log records the name and nothing else', async () => {
    const { withAudit } = await import('../../src/mcp/audit.js')
    writeSecret('OLD_KEY', KNOWN_VALUE)
    const wrapped = withAudit('clawops_secret_delete', (i: { name: string; yes: boolean }) =>
      handleSecretDelete(i, elicitingServer().server))
    await wrapped({ name: 'OLD_KEY', yes: true })

    const logged = readFileSync(path.join(clawopsDir(), 'mcp-audit.log'), 'utf-8')
    const entry = JSON.parse(logged.trim().split('\n').pop()!) as { tool: string; args: unknown }
    expect(entry.tool).toBe('clawops_secret_delete')
    expect(entry.args).toEqual({ name: 'OLD_KEY', yes: true })
    expect(logged).not.toContain(KNOWN_VALUE)
  })
})
