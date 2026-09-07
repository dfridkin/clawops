import { defineCommand } from 'citty'
import process from 'node:process'
import { failure, info } from '../../output/human.js'
import { printJson, jsonOk } from '../../output/json.js'
import { renderTable } from '../../output/table.js'

export default defineCommand({
  meta: {
    name: 'agents',
    description: 'Manage OpenClaw agents (list | logs <name>)',
  },
  args: {
    stack: { type: 'string', description: 'Target stack name' },
    json: { type: 'boolean', description: 'Emit JSON (for list)' },
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
        const result = await session.exec(
          "docker exec openclaw openclaw agents list --json 2>/dev/null || echo '[]'",
          abortController.signal,
        )
        type AgentRecord = { name: string; status: string; [k: string]: unknown }
        let agents: AgentRecord[] = []
        try {
          agents = JSON.parse(result.stdout.trim()) as AgentRecord[]
        } catch {
          agents = []
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
        const logStream = await session.stream(
          `docker exec -t openclaw openclaw agents logs ${name!} --follow`,
          abortController.signal,
        )
        logStream.pipe(process.stdout)
        await new Promise<void>((resolve) => {
          logStream.on('end', resolve)
          logStream.on('close', resolve)
          abortController.signal.addEventListener('abort', () => resolve(), { once: true })
        })
      }
    } finally {
      release()
      if (action !== 'logs') drainPool()
    }
  },
})
