import { defineCommand } from 'citty'
import process from 'node:process'
import { success, failure, warn, info, spinner } from '../../output/human.js'
import { printJson, jsonOk, jsonError } from '../../output/json.js'
import { renderTable } from '../../output/table.js'
import type { FleetHost } from '../../hostagent/fleet-status.js'

// `clawops fleet status` — every stack's host agent, and whether the fleet's peers can work
// (ADR 0015). The MCP equivalent is clawops_stacks_list with fleet: true; both call
// src/hostagent/fleet-status.ts.

const STATE: Record<FleetHost['state'], string> = {
  ok: 'ok',
  problems: 'problems',
  none: 'no host agent',
  undeployed: 'not deployed',
  unreachable: 'unreachable',
}

function row(h: FleetHost): string[] {
  const f = h.fleet
  const fleet = !f ? '—' : [f.serves ? `serves ${f.serves}` : '', f.peers.length > 0 ? `peers ${f.peers.map((p) => p.stack).join(', ')}` : ''].filter(Boolean).join('; ')
  const tailnet = !f ? '—' : !f.tailnet ? 'no answer' : f.tailnet.state === 'Running' ? (f.tailnet.dnsName ?? f.tailnet.hostName ?? 'running') : f.tailnet.state
  return [
    h.stack,
    STATE[h.state],
    h.service ?? '—',
    h.agentId ? `${h.agentId}${h.strict ? ' (strict)' : ''}` : '—',
    fleet,
    !f ? '—' : f.firewall === 'ok' ? 'ok' : 'not as installed',
    tailnet,
  ]
}

const statusCmd = defineCommand({
  meta: {
    name: 'status',
    description: 'List every stack\'s host agent, its fleet membership and its peers, read from each host over SSH',
  },
  args: {
    stack: { type: 'string', description: 'Read only these stacks, comma-separated or repeated (default: every stack in your config)' },
    json: { type: 'boolean', description: 'Emit structured JSON output' },
  },
  async run({ args }) {
    const { fleetStatusFromConfig } = await import('../../hostagent/fleet-status.js')
    const { drainPool } = await import('../../transport/pool.js')
    const ac = new AbortController()
    process.on('SIGINT', () => { ac.abort(); process.exit(130) })

    const raw = Array.isArray(args.stack) ? args.stack : args.stack === undefined ? [] : [args.stack]
    const only = raw.flatMap((x) => String(x).split(',')).map((s) => s.trim()).filter(Boolean)
    const spin = args.json ? undefined : spinner('Reading each stack\'s host...')
    let r: Awaited<ReturnType<typeof fleetStatusFromConfig>>
    try {
      r = await fleetStatusFromConfig(only, ac.signal)
    } finally {
      drainPool()
    }
    if (!r.ok) {
      if (args.json) printJson(jsonError(r.reason))
      else { spin?.stop(); failure(r.reason) }
      process.exit(2)
    }
    const { status } = r
    const troubled = status.hosts.filter((h) => h.state === 'problems' || h.state === 'unreachable')

    if (args.json) {
      printJson(jsonOk(status))
    } else {
      spin?.stop()
      if (status.hosts.length === 0) {
        info('No stacks configured.')
        return
      }
      process.stdout.write(
        '\n' +
          renderTable(['Stack', 'State', 'Service', 'Agent', 'Fleet', 'Firewall', 'Tailnet'], status.hosts.map(row)) +
          '\n\n',
      )
      for (const h of troubled) {
        for (const p of h.problems) (h.state === 'unreachable' ? warn : failure)(`${h.stack}: ${p}`)
      }
      const summary = `${status.agents} host agent${status.agents === 1 ? '' : 's'} on ${status.hosts.length} stack${status.hosts.length === 1 ? '' : 's'}, ${status.members} in the fleet.`
      if (troubled.length === 0) success(summary)
      else info(summary)
    }
    // A script can tell a healthy fleet from one that needs looking at.
    if (troubled.length > 0) process.exit(1)
  },
})

export default defineCommand({
  meta: {
    name: 'fleet',
    description: 'See every stack\'s host agent and whether its peers can reach each other (ADR 0015)',
  },
  subCommands: {
    status: statusCmd,
  },
})
