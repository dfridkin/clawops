import { defineCommand } from 'citty'
import process from 'node:process'
import { success, failure, warn, info, spinner } from '../../output/human.js'
import { printJson, jsonOk, jsonError } from '../../output/json.js'

// `clawops agent` — the host agent (ADR 0014). CLI-only: installing a host agent is the
// operator choosing what an agent may do, so no agent can do it (§6, tests/mcp/parity.test.ts).

/** `--operator a --operator b`, `--operator a,b`, or both. */
function listArg(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : v === undefined ? [] : [v]
  return raw.flatMap((x) => String(x).split(',')).map((s) => s.trim()).filter(Boolean)
}

async function openStackSession(stack: string | undefined, signal: AbortSignal) {
  const { buildContext } = await import('../context.js')
  const { resolveConn } = await import('../../transport/conn.js')
  const { acquireSession } = await import('../../transport/pool.js')
  const ctx = buildContext({ stack })
  const conn = await resolveConn(ctx)
  const { session, release } = await acquireSession({ ...conn, signal })
  return { ctx, conn, session, release }
}

const installCmd = defineCommand({
  meta: {
    name: 'install',
    description: 'Install a host agent on a stack\'s gateway host, for one OpenClaw agent that only the operator can reach',
  },
  args: {
    stack: { type: 'string', description: 'Target stack name' },
    agent: { type: 'string', description: 'The OpenClaw agent that gets the clawops tools. Must not be the default agent', required: true },
    operator: { type: 'string', description: 'Who may reach that agent, as <channel>:<peer-id>. Repeatable, or comma-separated', required: true },
    allow: { type: 'string', description: 'Destructive tools the agent may hand off to you, comma-separated: clawops_gateway_restart, clawops_gateway_update, clawops_backup_restore, clawops_config_set, clawops_config_unset, clawops_harden' },
    strict: { type: 'boolean', description: 'Refuse while any other agent can run commands or read files in the gateway container (otherwise reported)' },
    port: { type: 'string', description: 'Port the host agent listens on, on the Docker bridge (default 18790)' },
    'serve-peers': { type: 'string', description: 'Join a fleet and answer peer host agents carrying this tailnet tag, e.g. tag:clawops-agent. The host must carry the tag (ADR 0015)' },
    peer: { type: 'string', description: 'A peer this host agent may query, as <stack>=<tailnet name>. Repeatable, or comma-separated. Requires --strict (ADR 0015)' },
    json: { type: 'boolean', description: 'Emit structured JSON output' },
  },
  async run({ args }) {
    const { installHostAgent } = await import('../../hostagent/install.js')
    const { drainPool } = await import('../../transport/pool.js')
    const ac = new AbortController()
    process.on('SIGINT', () => { ac.abort(); process.exit(130) })
    process.on('SIGTERM', () => { ac.abort(); process.exit(143) })

    const { ctx, conn, session, release } = await openStackSession(args.stack, ac.signal)
    const spin = args.json ? undefined : spinner(`Connecting to ${conn.host}...`)
    try {
      const result = await installHostAgent(session, {
        stack: ctx.stackName,
        provider: ctx.adapter.name,
        agentId: String(args.agent),
        operators: listArg(args.operator),
        allow: listArg(args.allow),
        strict: Boolean(args.strict),
        port: args.port ? Number(args.port) : undefined,
        servePeers: args['serve-peers'] ? String(args['serve-peers']) : undefined,
        peers: listArg(args.peer),
      }, { step: (m) => { if (spin) spin.text = m } }, ac.signal)

      if (args.json) {
        printJson(result.ok ? jsonOk(result) : jsonError(`${result.stage}: ${result.failures.join('\n')}`))
        if (!result.ok) process.exit(1)
        return
      }
      if (!result.ok) {
        const refused = result.stage === 'input' || result.stage === 'host' || result.stage === 'guardrail'
        spin?.fail(refused ? 'Refused. Nothing was installed.' : `Install failed while ${STAGE[result.stage]}.`)
        for (const f of result.failures) failure(f)
        if (result.stage === 'guardrail') info('Fix the gateway configuration, then run this again.')
        process.exit(1)
      }
      spin?.succeed(`Host agent installed for "${String(args.agent)}" on ${ctx.stackName}, and the gateway reached it.`)
      if (result.deniedAdded.length > 0) info(`Denied clawops to: ${result.deniedAdded.join(', ')}`)
      if (result.fleet) {
        info('Fleet firewall table loaded, and loaded again at every boot before Docker starts.')
        if (result.fleet.serves) info(`Fleet tag: ${result.fleet.serves}`)
        if (result.fleet.peers.length > 0) info(`Peers: ${result.fleet.peers.map((p) => `${p.stack} (${p.node})`).join(', ')}`)
      }
      for (const f of result.afterWire) warn(f)
      if (result.reach.length > 0) {
        warn('Other agents can act inside the gateway container, and so can reach what the host agent can:')
        for (const r of result.reach) info(`  ${r}`)
        info('Install with --strict to refuse while any do.')
      }
      success(`Ask "${String(args.agent)}" in your direct conversation: "check if this stack is healthy"`)
    } catch (err) {
      spin?.fail('Install failed.')
      failure(err instanceof Error ? err.message : String(err))
      process.exit(1)
    } finally {
      release()
      drainPool()
    }
  },
})

const STAGE: Record<string, string> = {
  verify: 'writing the deny entries',
  install: 'installing files on the host',
  start: 'starting the service',
  wire: 'wiring the gateway',
}

const uninstallCmd = defineCommand({
  meta: {
    name: 'uninstall',
    description: 'Remove the host agent from a stack\'s gateway host and unwire the gateway',
  },
  args: {
    stack: { type: 'string', description: 'Target stack name' },
    purge: { type: 'boolean', description: 'Also remove the host agent\'s audit log and handoffs' },
    json: { type: 'boolean', description: 'Emit structured JSON output' },
  },
  async run({ args }) {
    const { uninstallHostAgent } = await import('../../hostagent/install.js')
    const { drainPool } = await import('../../transport/pool.js')
    const ac = new AbortController()
    process.on('SIGINT', () => { ac.abort(); process.exit(130) })

    const { conn, session, release } = await openStackSession(args.stack, ac.signal)
    const spin = args.json ? undefined : spinner(`Connecting to ${conn.host}...`)
    try {
      const result = await uninstallHostAgent(session, { purge: Boolean(args.purge) }, { step: (m) => { if (spin) spin.text = m } }, ac.signal)
      if (args.json) {
        printJson(result.failures.length === 0 ? jsonOk(result) : jsonError(result.failures.join('\n')))
      } else {
        if (result.failures.length === 0) spin?.succeed('Host agent removed.')
        else spin?.fail('Host agent partly removed.')
        for (const r of result.removed) info(`  removed ${r}`)
        for (const k of result.kept) info(`  kept ${k}`)
        for (const f of result.failures) failure(f)
      }
      if (result.failures.length > 0) process.exit(1)
    } finally {
      release()
      drainPool()
    }
  },
})

export default defineCommand({
  meta: {
    name: 'agent',
    description: 'Install or remove a host agent: clawops on the gateway host, for one operator-only OpenClaw agent (ADR 0014)',
  },
  subCommands: {
    install: installCmd,
    uninstall: uninstallCmd,
  },
})
