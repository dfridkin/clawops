// clawops_stacks_list and clawops_stacks_delete handlers

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { StacksListInput, StacksDeleteInput } from '../_generated.js'
import { getConfig } from '../../../config/store.js'
import { checkStackDelete, deleteStackFromConfig, forgetNotice } from '../../../config/stack-delete.js'
import { confirmDestructive } from '../_confirm.js'
import { okText, errText } from '../_conn.js'
import { hostAgent } from '../../../hostagent/mode.js'
import type { FleetHost, FleetStatus } from '../../../hostagent/fleet-status.js'
import type { HostAgentConfig } from '../../../hostagent/config.js'

export async function handleStacksList(input: StacksListInput, _server: McpServer): Promise<CallToolResult> {
  // A host agent is one stack, the host it runs on; the operator's list is on their machine.
  const agent = hostAgent()
  if (agent) return hostAgentStacks(agent, input)
  if (input.fleet) return fleetList(input)
  const config = getConfig()
  if (!config) {
    return { content: [{ type: 'text', text: JSON.stringify({ stacks: [] }) }] }
  }
  const stacks = Object.entries(config.stacks).map(([name, cfg]) => ({
    name,
    provider: cfg.provider,
    region: cfg.region,
    stateUrl: cfg.stateUrl,
    isDefault: name === config.defaults.stack,
  }))
  return { content: [{ type: 'text', text: JSON.stringify({ stacks }, null, 2) }] }
}

/**
 * On a host agent: this host and its fleet peers (ADR 0015 §5). Each peer is asked, so the list
 * says which ones answered; an unreachable peer is a note, not a failure. `fleet: true` reads
 * this host and has each peer report itself.
 */
async function hostAgentStacks(agent: HostAgentConfig, input: StacksListInput): Promise<CallToolResult> {
  const { askPeer, fleetFromHere } = await import('../../../hostagent/peer-route.js')
  const all = agent.fleet?.peers ?? []
  const only = (input.stackNames ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const known = [agent.stack, ...all.map((p) => p.stack)]
  const unknown = only.filter((s) => !known.includes(s))
  if (unknown.length > 0) {
    return errText(`This host agent knows only stack "${agent.stack}" and its peers (${all.length > 0 ? all.map((p) => p.stack).join(', ') : 'none'}); not ${unknown.map((s) => `"${s}"`).join(', ')}.`)
  }
  const peers = only.length > 0 ? all.filter((p) => only.includes(p.stack)) : all
  const includeSelf = only.length === 0 || only.includes(agent.stack)

  if (input.fleet) return okText(fleetText(await fleetFromHere(agent, peers, includeSelf)))

  const answers = await Promise.all(peers.map((p) => askPeer(agent, p, 'clawops_stacks_list', {})))
  const stacks = [
    ...(includeSelf ? [{ name: agent.stack, provider: agent.provider, isDefault: true, hostAgent: true }] : []),
    ...peers.map((p, i) => {
      const a = answers[i]!
      return { name: p.stack, peer: p.node, answered: a.ok, ...(a.ok ? { answeredBy: a.answeredBy } : { note: a.reason }) }
    }),
  ]
  return { content: [{ type: 'text', text: JSON.stringify({ stacks }, null, 2) }] }
}

/**
 * `clawops_stacks_list` on the peer listener: this host only, and with `fleet: true` this host as
 * `clawops fleet status` reads it. A peer never forwards, so a fleet query is one hop.
 */
export async function handlePeerStacksList(input: StacksListInput, _server: McpServer): Promise<CallToolResult> {
  const agent = hostAgent()
  if (!agent) return errText('Only a host agent answers peers.')
  if (input.fleet) {
    const { thisHostForPeer } = await import('../../../hostagent/peer-route.js')
    return okText(JSON.stringify({ host: await thisHostForPeer(agent) }))
  }
  const stacks = [{ name: agent.stack, provider: agent.provider, isDefault: true, hostAgent: true }]
  return { content: [{ type: 'text', text: JSON.stringify({ stacks }, null, 2) }] }
}

/** fleet: true — the same reading as `clawops fleet status` (src/hostagent/fleet-status.ts). */
async function fleetList(input: StacksListInput): Promise<CallToolResult> {
  const { fleetStatusFromConfig } = await import('../../../hostagent/fleet-status.js')
  const { drainPool } = await import('../../../transport/pool.js')
  const only = (input.stackNames ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  try {
    const r = await fleetStatusFromConfig(only)
    if (!r.ok) return errText(r.reason)
    return okText(fleetText(r.status))
  } finally {
    drainPool()
  }
}

const MAX_BYTES = 8 * 1024

/**
 * The status as JSON within R14's 8 KB. A large fleet first loses the detail of hosts with
 * nothing wrong, then every host's detail but its state and problems: what is wrong is what an
 * agent is asked about, and a cut-off JSON document is no answer at all.
 */
export function fleetText(status: FleetStatus): string {
  const fits = (v: unknown) => { const t = JSON.stringify(v); return Buffer.byteLength(t) <= MAX_BYTES ? t : undefined }
  const brief = (h: FleetHost) => ({ stack: h.stack, state: h.state, problems: h.problems })
  const whole =
    fits({ fleet: status }) ??
    fits({ fleet: { ...status, hosts: status.hosts.map((h) => (h.state === 'ok' ? brief(h) : h)) }, note: 'Hosts with no problems are shown in brief. `clawops fleet status --json` has every detail.' }) ??
    fits({ fleet: { ...status, hosts: status.hosts.map(brief) }, note: 'Every host is shown in brief. `clawops fleet status --json` has every detail.' })
  if (whole) return whole
  const bad = status.hosts.filter((h) => h.state !== 'ok').map(brief)
  for (let n = bad.length; n >= 0; n--) {
    const t = fits({
      fleet: { agents: status.agents, members: status.members, hosts: bad.slice(0, n) },
      note: `${status.hosts.length} hosts are too many to list here; these are the first ${n} with problems. Pass stackNames to read fewer.`,
    })
    if (t) return t
  }
  return JSON.stringify({ fleet: { agents: status.agents, members: status.members, hosts: [] }, note: 'Pass stackNames to read fewer hosts.' })
}

/**
 * clawops_stacks_delete — forget a stack. The checks and the config write are the CLI's
 * (src/config/stack-delete.ts), so the tool refuses exactly what `clawops stacks delete` does,
 * in the same words; `force` is `--force`.
 */
export async function handleStacksDelete(input: StacksDeleteInput, server: McpServer): Promise<CallToolResult> {
  const force = input.force === true
  const check = await checkStackDelete(input.name, { force })
  if (!check.ok) return errText(check.reason)

  // R19: confirm unless the caller says the user already approved.
  if (!input.yes) {
    const consequence = force
      ? 'force skips the still-deployed check: if this stack is still deployed, its resources ' +
        'stay running and billing, and clawops can no longer see them.'
      : check.warnings.length > 0
        ? `${check.warnings.join(' ')} If it is still deployed, its resources stay running and billing.`
        : 'clawops sees no deployment for it, so nothing should be left running.'
    const confirmation = await confirmDestructive(server, {
      message:
        `Forget stack "${input.name}"? This removes it from ~/.clawops/config.json; it does NOT ` +
        `tear down its infrastructure. ${consequence}` +
        (check.isDefault ? ' It is the default stack, so another stack becomes the default.' : ''),
      title: 'Confirm forgetting the stack',
      what: `forgetting stack "${input.name}"`,
    })
    if (!confirmation.confirmed) return okText(confirmation.reason)
  }

  const deleted = deleteStackFromConfig(input.name)
  const lines = [...check.warnings, forgetNotice(input.name), deleted.message]
  if (deleted.newDefaultMessage) lines.push(deleted.newDefaultMessage)
  return okText(lines.join('\n'))
}
