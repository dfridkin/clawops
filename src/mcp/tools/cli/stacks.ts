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

export async function handleStacksList(input: StacksListInput, _server: McpServer): Promise<CallToolResult> {
  // A host agent is one stack, the host it runs on; the operator's list is on their machine.
  const agent = hostAgent()
  if (agent) {
    if (input.fleet) return errText(FLEET_ON_HOST)
    const stacks = [{ name: agent.stack, provider: agent.provider, isDefault: true, hostAgent: true }]
    return { content: [{ type: 'text', text: JSON.stringify({ stacks }, null, 2) }] }
  }
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
 * A host agent reads only its own host. What it may learn of its peers is the peer listener's
 * to decide (WO-67 parts C and D), so until then the fleet view stays on the operator's machine.
 */
const FLEET_ON_HOST =
  'A host agent does not report the fleet: it reads only its own host. The operator sees every ' +
  'host agent with `clawops fleet status` on their own machine.'

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
