// Wiring the gateway's AI to clawops as an MCP client (WO-28, corrected in WO-61).
// Used by `clawops mcp wire` and the setup wizard.

import type { SshSession } from '../transport/ssh.js'
import { execPrivileged } from '../transport/privileged.js'
import { MCP_HTTP_PORT } from '../mcp/server.js'
import { CLAWOPS_TOOL_PATTERN, deniesClawops } from '../hostagent/guardrail.js'

/**
 * The name the entry is stored under in the gateway's `mcp.servers`.
 *
 * WO-28 wrote `gateway.mcpClients.clawops`, which is not a key OpenClaw has ever had —
 * verified against the config schemas of both 2026.7.1-2 and 2026.9.2. On the 1.x line
 * nothing validated the write, so clawops stored a key nothing read, restarted the gateway,
 * and reported success. Nothing was ever wired.
 */
export const GATEWAY_MCP_NAME = 'clawops'

/**
 * Default URL the gateway uses to reach clawops.
 *
 * `host.docker.internal` rather than 127.0.0.1: the gateway runs in a container, where
 * loopback is the container. The alias is already resolvable because the run command passes
 * `--add-host=host.docker.internal:host-gateway` for host-local model runtimes.
 *
 * Not stdio. WO-28 specified `command: "clawops"`, which would spawn inside the container —
 * and `clawops` is not on PATH there, nor installed by anything. Verified against the image.
 */
export function defaultGatewayMcpUrl(port: number = MCP_HTTP_PORT): string {
  return `http://host.docker.internal:${port}/`
}

export interface WireOpts {
  /** Where the gateway should reach clawops. */
  url?: string
  /** Bearer token the clawops MCP server requires. */
  token?: string
  /** Replace an existing entry rather than refusing. */
  rewire?: boolean
  /** Between checks for the container after a restart. Tests shorten it. */
  pollMs?: number
}

export type WireResult =
  | { status: 'wired'; rewired: boolean; url: string }
  | { status: 'exists'; url: string }
  | { status: 'probe-failed'; error: string; url: string }
  | { status: 'unsupported'; url: string }

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

const OC = 'docker exec openclaw openclaw mcp'

/**
 * Wire clawops into the gateway's MCP servers.
 *
 * Delegates to `openclaw mcp add`, which **probes the server before saving**. That is the
 * whole point of using it: clawops cannot write a working-looking entry for a server that
 * is not answering, so "wired" means the gateway connected, not that a file was written.
 */
/**
 * Does this gateway's OpenClaw have `mcp add`?
 *
 * Asked of the binary rather than inferred from a version string. `2026.4.5` ships
 * `openclaw mcp` with only `list` and `serve`; `2026.7.1-2` and later add `add`, `unset` and
 * `reload`. A version comparison would need a boundary nobody has measured — and WO-28's
 * `>= 2026.4` gate, invented the same way, gated on a capability that never existed at all.
 */
async function supportsMcpAdd(session: SshSession, signal: AbortSignal): Promise<boolean> {
  const help = await execPrivileged(session, `${OC} add --help`, signal)
  return help.code === 0
}

/**
 * A gateway restart kills any `docker exec` running in the container (137 or 143). Measured on
 * 2026.9.2: writing a channel's settings restarts the gateway about two seconds later, and the
 * container is recreated, down for around ten seconds. Wait until it takes commands again.
 */
async function afterRestart(session: SshSession, signal: AbortSignal, pollMs: number): Promise<void> {
  for (let i = 0; i < Math.ceil(180_000 / pollMs); i++) {
    if ((await execPrivileged(session, 'docker exec openclaw true', signal)).code === 0) return
    await new Promise((r) => setTimeout(r, pollMs))
  }
}

const KILLED = new Set([137, 143])

export async function wireGatewayMcp(
  session: SshSession,
  signal: AbortSignal,
  opts: WireOpts = {},
): Promise<WireResult> {
  const url = opts.url ?? defaultGatewayMcpUrl()

  if (!(await supportsMcpAdd(session, signal))) return { status: 'unsupported', url }

  const existing = await execPrivileged(session, `${OC} show ${GATEWAY_MCP_NAME}`, signal)
  const alreadyWired = existing.code === 0
  if (alreadyWired && !opts.rewire) return { status: 'exists', url }

  if (alreadyWired) {
    // `add` refuses a name that exists, so a rewire is unset-then-add. Verified against
    // 2026.9.2: a second `add` answers 'MCP server "clawops" already exists.'
    const removed = await execPrivileged(session, `${OC} unset ${GATEWAY_MCP_NAME}`, signal)
    if (removed.code !== 0) {
      return {
        status: 'probe-failed',
        error: `Could not remove the existing entry: ${removed.stderr.trim() || removed.stdout.trim()}`,
        url,
      }
    }
  }

  const flags = [
    `--transport streamable-http`,
    `--url ${shellQuote(url)}`,
    ...(opts.token ? [`--header ${shellQuote(`Authorization=Bearer ${opts.token}`)}`] : []),
  ].join(' ')

  const pollMs = opts.pollMs ?? 2000
  let added = await execPrivileged(session, `${OC} add ${GATEWAY_MCP_NAME} ${flags}`, signal)
  for (let attempt = 0; attempt < 3 && KILLED.has(added.code); attempt++) {
    // Killed by a gateway restart, its own save's or one already under way. `show` says
    // whether the save happened; if it did not, add again now the gateway is back.
    await afterRestart(session, signal, pollMs)
    const saved = await execPrivileged(session, `${OC} show ${GATEWAY_MCP_NAME}`, signal)
    added = saved.code === 0
      ? { ...added, code: 0 }
      : await execPrivileged(session, `${OC} add ${GATEWAY_MCP_NAME} ${flags}`, signal)
  }
  if (added.code !== 0) {
    // The probe output names the actual failure — an unreachable host, a refused
    // connection, a 401. Passed through rather than summarised: clawops cannot tell which
    // of those the operator needs to hear about.
    return {
      status: 'probe-failed',
      error: (added.stderr.trim() || added.stdout.trim() || `exit ${added.code}`),
      url,
    }
  }

  // Cheaper and less disruptive than a gateway restart, which is what this used to do:
  // agents pick up the new config on their next runtime build.
  const reloaded = await execPrivileged(session, `${OC} reload`, signal)
  if (KILLED.has(reloaded.code)) await afterRestart(session, signal, pollMs)

  return { status: 'wired', rewired: alreadyWired, url }
}

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined
const denyOf = (tools: unknown): string[] =>
  (Array.isArray(obj(tools)?.['deny']) ? (obj(tools)!['deny'] as unknown[]) : [])
    .filter((p): p is string => typeof p === 'string')

export interface ExposedAgent {
  /** Undefined for a gateway with no agent roster, which runs one unnamed agent. */
  id?: string
  /** Answers traffic no binding claims, so anyone who can message the gateway reaches it. */
  isDefault: boolean
}

/**
 * The agents a wired gateway offers clawops's tools to (SP-13 finding 2).
 *
 * `mcp.servers` is gateway-wide: every agent is offered every clawops tool unless a deny covering
 * `clawops__*` removes them. A gateway-wide deny removes them from every agent, and cannot be
 * reopened for one (finding 4). The default agent is judged as the guardrail judges it: marked
 * `default`, or the only agent.
 */
export function exposedAgents(config: Obj): ExposedAgent[] {
  if (deniesClawops(denyOf(config['tools']))) return []
  const entries = obj(obj(config['agents'])?.['entries']) ?? {}
  const ids = Object.keys(entries)
  if (ids.length === 0) return [{ isDefault: true }]
  return ids
    .filter((id) => !deniesClawops(denyOf(obj(entries[id])?.['tools'])))
    .map((id) => ({ id, isDefault: obj(entries[id])?.['default'] === true || ids.length === 1 }))
}

/** What `mcp wire` and the setup wizard say about who can now call clawops. */
export function exposureLines(agents: readonly ExposedAgent[]): string[] {
  if (agents.length === 0) return []
  const name = (a: ExposedAgent): string =>
    (a.id ? `"${a.id}"` : 'the gateway\'s agent') +
    (a.isDefault ? ' (the default agent: anyone who can message the gateway reaches it)' : '')
  return [
    agents.length === 1
      ? `${name(agents[0]!)} can now call every clawops tool, the destructive ones included.`
      : `These ${agents.length} agents can now call every clawops tool, the destructive ones included:`,
    ...(agents.length === 1 ? [] : agents.map((a) => `  ${name(a)}`)),
    `To keep an agent away from clawops, add "${CLAWOPS_TOOL_PATTERN}" to its agents.entries.<id>.tools.deny.`,
    'For an agent that hands destructive changes back to you instead, see `clawops agent install`.',
  ]
}

/** Reads the gateway's config and says who can now call clawops. Never fails the wiring. */
export async function describeExposure(session: SshSession, signal?: AbortSignal): Promise<string[]> {
  try {
    const { readRemoteConfig } = await import('../plan/remote-config.js')
    return exposureLines(exposedAgents(await readRemoteConfig(session, signal)))
  } catch {
    return [
      'Could not read the gateway\'s config to say which agents can now call clawops.',
      `Every agent can, unless its tools.deny covers "${CLAWOPS_TOOL_PATTERN}".`,
    ]
  }
}
