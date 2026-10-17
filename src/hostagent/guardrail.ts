// The operator-only guardrail — docs/security/host-agent-disclosure-review.md and SP-13.
//
// A host agent's tools are complete: full logs, every agent's records. That is safe only if the
// operator is the one person who can talk to it. This module decides whether openclaw.json
// still says so. It is pure, so `agent install` and the server check the same thing, and each
// condition can be tested by breaking it alone.
//
// Each check is written to fail when what it needs is absent. A rule like "no binding routes a
// group to the agent" passes on a config with no bindings at all, which is the defect the
// mutation checks keep finding; "every binding is the operator's, and there is at least one"
// does not.

export interface GuardrailSubject {
  agentId: string
  /** `<channel>:<peer-id>`, as given to `agent install --operator`. */
  operators: readonly string[]
  /**
   * `agent install --strict`: another agent with command or file access in the gateway
   * container fails the guardrail instead of being reported (condition 6).
   */
  strict?: boolean
}

export type GuardrailResult = { ok: true } | { ok: false; failures: string[] }

import { TOOLSETS } from '../mcp/tools/_generated.js'

/** The MCP server name the gateway knows clawops by; its tools are `clawops__<tool>` (SP-13). */
export const CLAWOPS_TOOL_PATTERN = 'clawops__*'

/**
 * Every name the gateway can offer an agent for clawops: each tool, and the four the bridge adds
 * (SP-13 finding 1). A deny has to cover all of them; `clawops__clawops_*` alone would leave
 * `clawops__resources_read` reachable.
 */
const GATEWAY_TOOL_NAMES: readonly string[] = [
  ...new Set(Object.values(TOOLSETS).flat()),
  'prompts_list', 'prompts_get', 'resources_list', 'resources_read',
].map((t) => `clawops__${t}`)

function deniesClawops(patterns: readonly string[]): boolean {
  return GATEWAY_TOOL_NAMES.every((name) => patterns.some((p) => globMatch(p, name)))
}

const SAFE_DM_POLICIES = new Set(['pairing', 'allowlist', 'disabled'])
const SAFE_SESSION_VISIBILITY = new Set(['agent', 'self'])

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** OpenClaw's `*` patterns, as used in tools.deny and agentToAgent.allow. */
function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp('^' + pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')
  return re.test(value)
}

function parseOperator(op: string): { channel: string; peer: string } | undefined {
  const i = op.indexOf(':')
  if (i <= 0 || i === op.length - 1) return undefined
  return { channel: op.slice(0, i), peer: op.slice(i + 1) }
}

/**
 * Whether OpenClaw could route unclaimed traffic to this agent. Read from the pinned image
 * (2026.9.2, `resolveDefaultAgentId`): the one entry marked `default`, else the sole agent, else
 * none, and the route fails. Counted conservatively: any `default: true` marker, whatever
 * `agents.ownership` says, and being the only agent. Anyone who can message the gateway
 * reaches the default, so it can never be a host agent.
 */
function isDefaultAgent(entries: Obj, agentId: string): boolean {
  return obj(entries[agentId])?.['default'] === true || Object.keys(entries).length === 1
}

/** Keys OpenClaw uses to send traffic to a named agent outside `bindings`. */
const ROUTING_KEYS = new Set(['agentId', 'defaultAgent', 'defaultAgentId'])

/**
 * Every place outside `bindings` and the agent roster that names the agent. Telegram topics,
 * hooks mappings, the IMAP plugin, Talk, ACP's default and the system agent all route to a named
 * agent, and several carry messages from people who are not the operator. Rather than judge
 * each, any of them naming the host agent fails the guardrail.
 */
function otherRoutes(config: Obj, agentId: string): string[] {
  const found: string[] = []
  const want = agentId.toLowerCase()
  const walk = (v: unknown, at: string): void => {
    if (Array.isArray(v)) { v.forEach((item, i) => walk(item, `${at}[${i}]`)); return }
    const o = obj(v)
    if (!o) return
    for (const [k, child] of Object.entries(o)) {
      const here = at ? `${at}.${k}` : k
      if (here === 'bindings' || here === 'agents.entries') continue
      if (ROUTING_KEYS.has(k) && typeof child === 'string' && child.toLowerCase() === want) found.push(here)
      else walk(child, here)
    }
  }
  walk(config, '')
  return found
}

/**
 * Tools that act inside the gateway container, measured on the pinned image (2026.9.2). An agent
 * with any of them can read `openclaw.json`, which holds the token the gateway uses to reach
 * clawops, and the state directory, which holds every agent's transcripts. Neither the per-agent
 * clawops deny nor session visibility stops that (see the disclosure review, condition 6).
 *
 * The file-transfer plugin's tools are listed by name because denying `group:fs` and
 * `group:runtime` was measured to leave them, and `terminal` and `gateway`, offered.
 */
const CONTAINER_TOOLS: Record<string, string[]> = {
  'run commands': ['exec', 'process', 'terminal'],
  'read and write files': ['read', 'write', 'edit', 'apply_patch', 'file_fetch', 'file_write', 'dir_list', 'dir_fetch'],
  'change the gateway configuration': ['gateway'],
}

/** Groups whose members were measured; any other group in an allow list is assumed to grant everything. */
const KNOWN_GROUPS: Record<string, string[]> = {
  'group:runtime': ['exec', 'process'],
  'group:fs': ['read', 'write', 'edit', 'apply_patch'],
  'group:openclaw': [],
}

/** Profiles measured to offer none of CONTAINER_TOOLS. Any other profile, or none, offers them. */
const CONTAINED_PROFILES = new Set(['minimal', 'messaging'])

function strings(v: unknown): string[] {
  return arr(v).filter((p): p is string => typeof p === 'string')
}

/** Whether a tools.allow / alsoAllow / deny entry names this tool. */
function entryCovers(entry: string, tool: string, unknownGroupCovers: boolean): boolean {
  if (entry.startsWith('group:')) return KNOWN_GROUPS[entry]?.includes(tool) ?? unknownGroupCovers
  return globMatch(entry, tool)
}

/** Whether one tool policy (`allow`, `alsoAllow`, `profile`) would offer this tool by itself. */
function policyGrants(policy: Obj, tool: string): boolean {
  if (strings(policy['alsoAllow']).some((a) => entryCovers(a, tool, true))) return true
  if (Array.isArray(policy['allow'])) return strings(policy['allow']).some((a) => entryCovers(a, tool, true))
  const profile = policy['profile']
  return typeof profile === 'string' && !CONTAINED_PROFILES.has(profile)
}

/**
 * Which container tools an agent may be offered, judged conservatively: a tool counts unless
 * the agent's settings provably exclude it.
 *
 * - The base policy is the agent's `tools`, falling back to the gateway-wide `tools` for
 *   `allow` and `profile`. Denies and alsoAllows from both apply.
 * - `byProvider` and `toolsBySender` (per agent and gateway-wide, from the pinned schema) can
 *   carry their own allow, alsoAllow and profile. Any of them granting a tool counts, whatever
 *   the base deny says, since this is not proven to win over them.
 */
function containerToolsOf(config: Obj, entry: Obj | undefined): string[] {
  const layers = [obj(entry?.['tools']), obj(config['tools'])].filter((l): l is Obj => l !== undefined)
  const deny = layers.flatMap((l) => strings(l['deny']))
  const alsoAllow = layers.flatMap((l) => strings(l['alsoAllow']))
  const allowLayer = layers.find((l) => Array.isArray(l['allow']))
  const allow = allowLayer ? strings(allowLayer['allow']) : undefined
  const profile = layers.map((l) => l['profile']).find((p) => typeof p === 'string')
  const overrides = layers.flatMap((l) =>
    [l['byProvider'], l['toolsBySender']].flatMap((m) => Object.values(obj(m) ?? {}).map(obj)),
  ).filter((o): o is Obj => o !== undefined)

  return Object.values(CONTAINER_TOOLS).flat().filter((tool) => {
    if (overrides.some((o) => policyGrants(o, tool))) return true
    if (deny.some((d) => entryCovers(d, tool, false))) return false
    if (alsoAllow.some((a) => entryCovers(a, tool, true))) return true
    if (allow) return allow.some((a) => entryCovers(a, tool, true))
    return !(typeof profile === 'string' && CONTAINED_PROFILES.has(profile))
  })
}

/**
 * Other agents that can act inside the gateway container (condition 6). Reported, and refused
 * only under `strict`: most gateways' main agent has these tools, and such an agent can already
 * read every transcript on disk without clawops. What it gains through the token is the host
 * agent's read tools; destructive calls still hand off to the operator.
 */
export function containerReach(config: Obj, agentId: string): string[] {
  const entries = obj(obj(config['agents'])?.['entries']) ?? {}
  const out: string[] = []
  for (const [id, entry] of Object.entries(entries)) {
    if (id === agentId) continue
    const tools = containerToolsOf(config, obj(entry))
    if (tools.length === 0) continue
    const can = Object.entries(CONTAINER_TOOLS)
      .filter(([, names]) => names.some((n) => tools.includes(n)))
      .map(([what]) => what)
    out.push(
      `Agent "${id}" can ${can.join(', ')} in the gateway container (${tools.join(', ')}). It can read ` +
        `the clawops token from openclaw.json and call the host agent directly, and read the host ` +
        `agent's transcripts on disk. Give it tools.profile "messaging", or a tools.allow list without these.`,
    )
  }
  return out
}

export function checkGuardrail(config: Obj, subject: GuardrailSubject): GuardrailResult {
  const failures: string[] = []
  const { agentId } = subject
  const entries = obj(obj(config['agents'])?.['entries']) ?? {}

  // 1. A dedicated agent.
  if (!obj(entries[agentId])) {
    failures.push(`Agent "${agentId}" is not in agents.entries. Create it with \`openclaw agents add ${agentId}\`.`)
  } else if (isDefaultAgent(entries, agentId)) {
    failures.push(
      `Agent "${agentId}" is the gateway's default agent, which answers any message no binding ` +
        'claims. A host agent must be a separate agent that only the operator is bound to.',
    )
  }

  for (const where of otherRoutes(config, agentId)) {
    failures.push(`${where} sends traffic to "${agentId}". Only the operator's direct-message bindings may.`)
  }

  // 2. Bound only to the operator, by at least one direct-peer binding.
  const operators = subject.operators.map(parseOperator)
  if (operators.some((o) => o === undefined)) {
    failures.push('An operator is not in the form <channel>:<peer-id>.')
  }
  const bindings = arr(config['bindings']).map(obj).filter((b): b is Obj => b !== undefined)
  const own = bindings.filter((b) => b['agentId'] === agentId)
  const channelsUsed = new Map<string, Set<string | undefined>>()
  if (own.length === 0) {
    failures.push(
      `No binding routes the operator to "${agentId}". Bind it to the operator's direct ` +
        'conversation, for example with `openclaw agents bind`.',
    )
  }
  for (const b of own) {
    const match = obj(b['match'])
    const channel = typeof match?.['channel'] === 'string' ? match['channel'] : undefined
    const peer = obj(match?.['peer'])
    const kind = peer?.['kind']
    const id = typeof peer?.['id'] === 'string' ? peer['id'] : undefined
    const describe = `binding ${JSON.stringify(match ?? {})}`
    if (b['type'] === 'acp') {
      failures.push(`An ACP ${describe} routes to "${agentId}". A host agent is reached only by the operator's direct messages.`)
      continue
    }
    if (!channel || !peer) {
      failures.push(`A ${describe} routes a whole channel to "${agentId}", not one person.`)
      continue
    }
    if (kind !== 'direct' && kind !== 'dm') {
      failures.push(`A ${describe} routes a ${String(kind)} conversation to "${agentId}". Only the operator's direct messages may.`)
      continue
    }
    if (!operators.some((o) => o?.channel === channel && o.peer === id)) {
      failures.push(`A ${describe} routes someone other than the operator to "${agentId}".`)
      continue
    }
    const accounts = channelsUsed.get(channel) ?? new Set()
    accounts.add(typeof match?.['accountId'] === 'string' ? match['accountId'] : undefined)
    channelsUsed.set(channel, accounts)
  }

  // 3. The channels those bindings use will not let strangers open a DM.
  const channels = obj(config['channels']) ?? {}
  for (const [channel, accounts] of channelsUsed) {
    const ch = obj(channels[channel])
    for (const account of accounts) {
      const acc = account ? obj(obj(ch?.['accounts'])?.[account]) : undefined
      const policy = acc?.['dmPolicy'] ?? ch?.['dmPolicy']
      const where = account ? `channels.${channel}.accounts.${account}.dmPolicy` : `channels.${channel}.dmPolicy`
      if (typeof policy !== 'string' || !SAFE_DM_POLICIES.has(policy)) {
        failures.push(
          `${where} is ${policy === undefined ? 'not set' : `"${String(policy)}"`}. Set it to ` +
            '"pairing" or "allowlist" explicitly, so an unknown sender cannot open a DM.',
        )
      }
    }
  }

  // 4. No reach across agents.
  const tools = obj(config['tools']) ?? {}
  const a2a = obj(tools['agentToAgent'])
  const a2aAllow = arr(a2a?.['allow']).filter((p): p is string => typeof p === 'string')
  const a2aOff = a2a?.['enabled'] === false
  const a2aExcludes = a2aAllow.length > 0 && !a2aAllow.some((p) => p !== '' && globMatch(p, agentId))
  if (!a2aOff && !a2aExcludes) {
    failures.push(
      'Agent-to-agent access reaches the host agent (it is on by default). Set ' +
        `tools.agentToAgent.enabled to false, or give tools.agentToAgent.allow a list that leaves "${agentId}" out.`,
    )
  }
  const visibility = obj(tools['sessions'])?.['visibility']
  if (typeof visibility !== 'string' || !SAFE_SESSION_VISIBILITY.has(visibility)) {
    failures.push(
      `tools.sessions.visibility is ${visibility === undefined ? 'not set (default "all")' : `"${String(visibility)}"`}. ` +
        'Set it to "agent" or "self", so other agents cannot read the host agent\'s sessions.',
    )
  }

  // 5. Every other agent is denied the clawops tools (SP-13). OpenClaw offers every agent every
  //    MCP tool by default, and the server cannot tell which agent is calling, so one agent
  //    without the deny is enough to reach clawops.
  const globalDeny = arr(tools['deny']).filter((p): p is string => typeof p === 'string')
  if (GATEWAY_TOOL_NAMES.some((name) => globalDeny.some((p) => globMatch(p, name)))) {
    failures.push(
      `tools.deny blocks the clawops tools for every agent, and a per-agent allow cannot reopen ` +
        `them (SP-13). Remove it and deny ${CLAWOPS_TOOL_PATTERN} on each other agent instead.`,
    )
  }
  for (const [id, entry] of Object.entries(entries)) {
    if (id === agentId) continue
    const deny = arr(obj(obj(entry)?.['tools'])?.['deny']).filter((p): p is string => typeof p === 'string')
    if (!deniesClawops(deny)) {
      failures.push(`Agent "${id}" can call clawops. Add "${CLAWOPS_TOOL_PATTERN}" to agents.entries.${id}.tools.deny.`)
    }
  }

  // 6. Under --strict, no other agent can act inside the gateway container.
  if (subject.strict) failures.push(...containerReach(config, agentId))

  return failures.length === 0 ? { ok: true } : { ok: false, failures }
}

/** The refusal a host agent gives while the guardrail does not hold. */
export function guardrailRefusal(failures: readonly string[]): string {
  return [
    'Refused. This host agent answers only its operator, and the gateway configuration no longer ' +
      'guarantees that:',
    ...failures.map((f) => `- ${f}`),
    'Nothing ran. The operator fixes the configuration and re-runs `clawops agent install` from their machine.',
  ].join('\n')
}
