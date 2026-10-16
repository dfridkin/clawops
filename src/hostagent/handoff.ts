// A destructive call, handed to the operator instead of run — ADR 0014 §2 and §3.
//
// The tool result is the exact CLI command that performs the same operation. The operator runs
// it on their own machine, with their own credentials, through the usual confirmation; running
// it is the approval. Nothing on the host changes.
//
// The command is shown in full and is what runs, so an agent that misdescribes it does no
// harm. Secrets are the exception: an argument the audit log would hide is replaced with a
// placeholder the operator fills in, so the value never enters the chat.

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { getConfigDir } from '../config/store.js'
import { isSecretPath } from '../mcp/audit.js'

/** What a secret argument becomes in a handoff. `<` makes an unedited paste fail rather than run. */
export const SECRET_PLACEHOLDER = '<value>'

/** Characters that need no quoting in a POSIX shell word. */
const PLAIN_WORD = /^[A-Za-z0-9._/:=@,+%^-]+$/

function word(s: string): string {
  if (s === SECRET_PLACEHOLDER) return s
  return PLAIN_WORD.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}

type Input = Record<string, unknown>

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

/**
 * The CLI argv for each handoff tool, after `clawops`, given its input and the agent's stack.
 *
 * Every flag here is one the CLI command declares; tests/hostagent/handoff.test.ts checks them
 * against the command definitions, so a handoff never names a flag the CLI lacks.
 */
const ARGV: Record<string, (input: Input, stack: string) => string[]> = {
  clawops_gateway_restart: (_i, stack) => ['gateway', 'restart', '--stack', stack],
  clawops_gateway_update: (i, stack) => ['gateway', 'update', str(i['version']) ?? '<version>', '--stack', stack],
  clawops_backup_restore: (i, stack) => [
    'backup', 'restore', '--file', str(i['file']) ?? '<archive>', '--stack', stack,
    ...(i['activate'] === true ? ['--activate'] : []),
  ],
  clawops_config_set: (i, stack) => {
    const key = str(i['key']) ?? '<key>'
    const value = typeof i['value'] === 'string' ? i['value'] : '<value>'
    return [
      'config', 'set', key, isSecretPath(key) ? SECRET_PLACEHOLDER : value, '--stack', stack,
      ...(i['restart'] === true ? ['--restart'] : []),
    ]
  },
  clawops_config_unset: (i, stack) => [
    'config', 'unset', str(i['key']) ?? '<key>', '--stack', stack,
    ...(i['restart'] === true ? ['--restart'] : []),
  ],
  clawops_harden: (i, stack) => [
    'harden', '--stack', stack,
    ...(str(i['options']) ? ['--options', str(i['options'])!] : []),
    ...(i['dryRun'] === true ? ['--dry-run'] : []),
    ...(i['tailscale'] === true ? ['--tailscale'] : []),
    ...(i['tailscaleRevert'] === true ? ['--tailscale-revert'] : []),
  ],
}

/** The argv builders, for the test that checks each flag exists on its command. */
export const HANDOFF_ARGV_FOR_TESTS: Readonly<typeof ARGV> = ARGV

export interface Handoff {
  id: string
  at: string
  tool: string
  stack: string
  /** The command as shown and recorded: secrets already replaced. */
  command: string
  /** True when a secret argument was replaced and the operator must fill it in. */
  needsValue: boolean
}

export function buildHandoff(tool: string, input: Input, stack: string, now = new Date()): Handoff {
  const argv = ARGV[tool]
  if (!argv) throw new Error(`${tool} has no handoff command`)
  const words = argv(input, stack)
  return {
    id: randomUUID(),
    at: now.toISOString(),
    tool,
    stack,
    command: ['clawops', ...words.map(word)].join(' '),
    needsValue: words.includes(SECRET_PLACEHOLDER),
  }
}

/** Where handoffs are recorded on the host, for the operator's `status` to show (§3). */
export function handoffsPath(): string {
  return path.join(getConfigDir(), 'handoffs.jsonl')
}

/** Append a handoff. Never fails the call: the tool result is the primary channel. */
export function recordHandoff(handoff: Handoff, file = handoffsPath()): boolean {
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    appendFileSync(file, JSON.stringify(handoff) + '\n', { encoding: 'utf-8', mode: 0o600 })
    return true
  } catch {
    return false
  }
}

/** How long an unanswered handoff is shown before it lapses (§3). */
export const HANDOFF_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Handoffs recorded and not yet lapsed, oldest first. Unreadable lines are skipped: the file is
 * written by this process, but the agent's host is not a place to trust a file's shape.
 */
export function pendingHandoffs(file = handoffsPath(), now = Date.now()): Handoff[] {
  let raw: string
  try {
    raw = readFileSync(file, 'utf-8')
  } catch {
    return []
  }
  const out: Handoff[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const h = JSON.parse(line) as Handoff
      if (typeof h.command !== 'string' || typeof h.at !== 'string') continue
      if (now - Date.parse(h.at) > HANDOFF_TTL_MS) continue
      out.push(h)
    } catch {
      continue
    }
  }
  return out
}

/** The tool result's text: the command first, for the agent to pass on verbatim. */
export function handoffText(handoff: Handoff, opts: { yesIgnored: boolean; recorded: boolean }): string {
  const lines = [
    `Needs the operator. Nothing was changed on this host. Run on your machine:`,
    '',
    `    ${handoff.command}`,
    '',
  ]
  if (handoff.needsValue) {
    lines.push(`Replace ${SECRET_PLACEHOLDER} with the value; it is kept out of this conversation.`)
  }
  if (opts.yesIgnored) {
    lines.push('`yes: true` was ignored: a host agent never runs a destructive operation itself.')
  }
  lines.push(
    opts.recorded
      ? `Pass this command to the operator as it is. It is also recorded on the host, and \`clawops status --stack ${handoff.stack}\` shows it to them.`
      : 'Pass this command to the operator as it is. It could not be recorded on the host, so this message is the only copy.',
  )
  return lines.join('\n')
}
