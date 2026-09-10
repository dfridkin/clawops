import { defineCommand } from 'citty'
import process from 'node:process'
import { failure, info } from '../../output/human.js'
import { printJson, jsonOk } from '../../output/json.js'
import { renderTable } from '../../output/table.js'
import { execPrivileged } from '../../transport/privileged.js'

export default defineCommand({
  meta: {
    name: 'agents',
    description: 'Manage OpenClaw agents (list | logs <name>)',
  },
  args: {
    stack: { type: 'string', description: 'Target stack name' },
    json: { type: 'boolean', description: 'Emit JSON (for list and logs)' },
    limit: { type: 'string', description: 'Max activity records for `logs` (default 50)' },
    cursor: { type: 'string', description: 'Continue from a previous `logs` result cursor' },
  },
  async run({ args }) {
    const { buildContext } = await import('../context.js')
    const { extractBaseOutputs } = await import('../../pulumi/outputs.js')
    const { acquireSession, drainPool } = await import('../../transport/pool.js')

    const [action, name] = (args._ ?? []) as string[]

    if (action === 'restart') {
      // Removed rather than widened. OpenClaw 2.0 has no per-agent restart — only
      // `gateway restart`, which drops every agent on the host. Silently turning a
      // one-agent restart into a whole-gateway restart is a surprise with an outage
      // in it, so this says what happened instead of doing something bigger.
      failure(
        'clawops agents restart was removed in clawops 2.0.\n' +
          '  OpenClaw 2.0 has no per-agent restart; the only restart it offers is\n' +
          '  gateway-wide and interrupts every agent on the host.\n' +
          '  Run `clawops gateway restart` if that is what you want.',
      )
      process.exit(2)
    }
    if (!action || !['list', 'logs'].includes(action)) {
      failure('Usage: clawops agents <list | logs <name>>')
      process.exit(2)
    }
    if (action === 'logs' && !name) {
      failure('Usage: clawops agents logs <name>')
      process.exit(2)
    }

    const ctx = buildContext(args)
    const stack = await ctx.getStack()
    const outputMap = await stack.outputs()
    const outputs: Record<string, unknown> = Object.fromEntries(
      Object.entries(outputMap).map(([k, v]) => [k, v.value]),
    )
    const base = extractBaseOutputs(outputs)
    const conn = ctx.adapter.getConnectionInfo({
      ...base,
      privateKeyPath: ctx.config.ssh.keyPath,
      knownHostsPath: ctx.config.ssh.knownHostsPath,
    })

    const abortController = new AbortController()
    process.on('SIGINT', () => abortController.abort())
    process.on('SIGTERM', () => abortController.abort())

    const { session, release } = await acquireSession({
      host: conn.host,
      port: conn.port,
      user: conn.user,
      privateKeyPath: conn.privateKeyPath,
      knownHostsPath: conn.knownHostsPath,
      signal: abortController.signal,
    })

    try {
      if (action === 'list') {
        const result = await execPrivileged(session,
          'docker exec openclaw openclaw agents list --json',
          abortController.signal,
        )
        type AgentRecord = { name: string; status: string; [k: string]: unknown }

        // The `|| echo '[]'` that used to be on this command, and the catch below that
        // fell back to an empty array, both reported "No agents running." when the real
        // answer was that the question never got asked — a stopped container, a gateway
        // still starting, a docker permission error. Failing is the honest outcome.
        if (result.code !== 0) {
          const why = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`
          failure(`Cannot list agents: ${why}`)
          process.exitCode = 1
          return
        }
        let agents: AgentRecord[]
        try {
          agents = JSON.parse(result.stdout.trim() || '[]') as AgentRecord[]
        } catch {
          failure(`Cannot list agents: unexpected output from OpenClaw: ${result.stdout.trim().slice(0, 200)}`)
          process.exitCode = 1
          return
        }

        if (args.json) {
          printJson(jsonOk(agents))
        } else if (agents.length === 0) {
          info('No agents running.')
        } else {
          process.stdout.write(
            '\n' +
              renderTable(
                ['Name', 'Status'],
                agents.map((a) => [a.name ?? '—', a.status ?? '—']),
              ) +
              '\n\n',
          )
        }
      } else {
        // logs <name>
        //
        // OpenClaw 2.0 removed `agents logs`, so the command this used to run does not exist
        // — it would have failed on every 2.0 gateway. Agent-scoped records live in the audit
        // log now. `openclaw logs` is gateway-wide and its envelope carries no agent key, so
        // filtering that would mean substring-matching a message field and hoping.
        const { agentAuditCommand } = await import('../../openclaw/logs.js')
        const limit = typeof args.limit === 'string' ? parseInt(args.limit, 10) : 50
        const result = await execPrivileged(
          session,
          agentAuditCommand({ agentId: name!, limit, cursor: typeof args.cursor === 'string' ? args.cursor : undefined }),
          abortController.signal,
        )

        if (result.code !== 0) {
          failure(`Cannot read activity for "${name}": ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`)
          process.exitCode = 1
          return
        }

        if (args.json) {
          process.stdout.write(result.stdout)
        } else {
          renderAgentRuns(name!, result.stdout)
        }
      }
    } finally {
      release()
      if (action !== 'logs') drainPool()
    }
  },
})

/**
 * Render an audit page as a table.
 *
 * `--follow` is not offered. `openclaw audit` is a paged query, not a stream: it returns a
 * cursor to continue from. Presenting a poll loop as a follow would be a different thing
 * wearing the old command's clothes.
 */
function renderAgentRuns(agentId: string, stdout: string): void {
  interface Run { at?: string; status?: string; kind?: string; summary?: string; message?: string }
  let page: { records?: Run[]; cursor?: string }
  try {
    page = JSON.parse(stdout.trim() || '{}') as typeof page
  } catch {
    failure(`Cannot read activity for "${agentId}": unexpected output: ${stdout.trim().slice(0, 200)}`)
    process.exitCode = 1
    return
  }

  const records = page.records ?? []
  if (records.length === 0) {
    info(`No recorded activity for agent "${agentId}".`)
    return
  }

  process.stdout.write(
    '\n' +
      renderTable(
        ['When', 'Status', 'Detail'],
        records.map((r) => [r.at ?? '—', r.status ?? '—', r.summary ?? r.message ?? '—']),
      ) +
      '\n',
  )
  if (page.cursor) {
    info(`More records: clawops agents logs ${agentId} --cursor ${page.cursor}`)
  }
  process.stdout.write('\n')
}
