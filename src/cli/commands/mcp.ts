import { defineCommand } from 'citty'
import process from 'node:process'
import { success, failure, warn, info, spinner } from '../../output/human.js'

// ── mcp serve ──────────────────────────────────────────────────────────────

const serveCmd = defineCommand({
  meta: {
    name: 'serve',
    description: 'Start the clawops MCP server',
  },
  args: {
    http: { type: 'string', description: 'HTTP port for standalone mode' },
    bind: { type: 'string', description: 'Bind address for HTTP mode (default 127.0.0.1)' },
    token: { type: 'string', description: 'Bearer token required on every HTTP request. Required unless bound to loopback; also read from CLAWOPS_MCP_TOKEN' },
    'read-only': { type: 'boolean', description: 'Only register read toolset' },
    'no-destructive': { type: 'boolean', description: 'Filter out destructive tools' },
    toolsets: { type: 'string', description: 'Comma-separated toolsets to enable' },
    inspector: { type: 'boolean', description: 'Enable MCP inspector' },
  },
  async run({ args }) {
    const { serveMcp } = await import('../../mcp/server.js')
    await serveMcp({
      port: args.http ? Number(args.http) : undefined,
      bind: args.bind,
      token: args.token,
      readOnly: Boolean(args['read-only']),
      noDestructive: Boolean(args['no-destructive']),
      toolsets: args.toolsets ? args.toolsets.split(',').map((s) => s.trim()) : undefined,
      inspector: Boolean(args.inspector),
    })
  },
})

// ── mcp install ────────────────────────────────────────────────────────────

const installCmd = defineCommand({
  meta: {
    name: 'install',
    description: 'Interactively wire clawops into AI editors (Claude Desktop, Claude Code, Cursor, …)',
  },
  args: {},
  async run() {
    const inquirer = (await import('inquirer')).default
    const { MCP_APPS, buildMcpEntry, writeAppConfigs } = await import('../mcp-apps.js')

    const mcpEntry = buildMcpEntry()

    if (!mcpEntry.resolved) {
      info('clawops is not installed globally — AI apps may not be able to start the MCP server.')
      info('Install it first:  npm install -g @clawops/cli')
      info('The config will still be written now using "clawops" as the command name.\n')
    }

    info('Use ↑↓ to move, Space to select/deselect, Enter to confirm.')

    const choices = MCP_APPS.map((app) => ({
      name: app.isInstalled()
        ? app.name
        : `${app.name}  (not detected — config will be written anyway)`,
      value: app.id,
      checked: app.isInstalled(),
    }))

    const { selectedIds } = await inquirer.prompt<{ selectedIds: string[] }>([{
      type: 'checkbox',
      name: 'selectedIds',
      message: 'Which AI editors should have access to clawops?',
      choices,
      pageSize: MCP_APPS.length + 1,
    }])

    const selected = MCP_APPS.filter((app) => selectedIds.includes(app.id))

    if (selected.length === 0) {
      info('No apps selected. Add this to an app\'s MCP config manually:')
      process.stdout.write(JSON.stringify({
        mcpServers: { clawops: { command: mcpEntry.command, args: mcpEntry.args } },
      }, null, 2) + '\n\n')
      info('Config file locations:')
      for (const app of MCP_APPS) {
        info(`  ${app.name.padEnd(18)} ${app.configPath()}`)
      }
      return
    }

    const results = writeAppConfigs(selected, { command: mcpEntry.command, args: mcpEntry.args })

    for (const r of results) {
      if (r.ok) {
        success(`${r.app.name} configured  (${r.configPath})`)
      } else {
        failure(`Could not configure ${r.app.name}: ${r.error ?? 'unknown error'}`)
      }
    }

    const needsRestart = selected.filter((app) => app.id !== 'claude-code')
    if (needsRestart.length > 0) {
      info(`Restart ${needsRestart.map((a) => a.name).join(', ')} to load the clawops tool.`)
    }
  },
})

// ── mcp wire ───────────────────────────────────────────────────────────────

const wireCmd = defineCommand({
  meta: {
    name: 'wire',
    description: 'Wire the gateway AI as an MCP client of clawops (WO-28)',
  },
  args: {
    stack: { type: 'string', description: 'Target stack name' },
    url: { type: 'string', description: 'Where the gateway should reach clawops (default http://host.docker.internal:18790/)' },
    token: { type: 'string', description: 'Bearer token the clawops MCP server requires' },
    rewire: { type: 'boolean', description: 'Replace an existing clawops entry' },
  },
  async run({ args }) {
    const { buildContext } = await import('../context.js')
    const { acquireSession, drainPool } = await import('../../transport/pool.js')
    const { extractBaseOutputs } = await import('../../pulumi/outputs.js')
    const { wireGatewayMcp } = await import('../mcp-wire.js')
    const { MCP_HTTP_PORT } = await import('../../mcp/server.js')

    const ac = new AbortController()
    process.on('SIGINT', () => { ac.abort(); process.exit(130) })
    process.on('SIGTERM', () => { ac.abort(); process.exit(143) })

    const ctx = buildContext({ stack: args.stack })

    let conn: { host: string; port: number; user: string; privateKeyPath: string; knownHostsPath: string }

    if (ctx.adapter.name === 'local') {
      if (!ctx.localState) {
        failure('Stack is not deployed. Run `clawops up` first.')
        process.exit(1)
      }
      const ls = ctx.localState
      conn = { host: ls.sshHost, port: ls.sshPort, user: ls.sshUser, privateKeyPath: ls.privateKeyPath, knownHostsPath: ls.knownHostsPath }
    } else {
      const stack = await ctx.getStack()
      const outputMap = await stack.outputs()
      const outputs: Record<string, unknown> = Object.fromEntries(
        Object.entries(outputMap).map(([k, v]) => [k, (v as { value: unknown }).value]),
      )
      if (!outputs['publicIp']) {
        failure('Stack has no outputs. Run `clawops up` first.')
        process.exit(1)
      }
      const base = extractBaseOutputs(outputs)
      conn = {
        host: base.publicIp,
        port: base.sshPort ?? 22,
        user: base.sshUser ?? 'ubuntu',
        privateKeyPath: ctx.config.ssh.keyPath,
        knownHostsPath: ctx.config.ssh.knownHostsPath,
      }
    }

    const spin = spinner(`Connecting to ${conn.host}...`)
    const { session, release } = await acquireSession({ ...conn, signal: ac.signal })
    try {
      spin.text = 'Asking the gateway to connect to clawops...'
      const result = await wireGatewayMcp(session, ac.signal, {
        url: typeof args.url === 'string' ? args.url : undefined,
        token: typeof args.token === 'string' ? args.token : undefined,
        rewire: Boolean(args.rewire),
      })

      if (result.status === 'unsupported') {
        spin.fail('This gateway has no `openclaw mcp add`, so clawops cannot wire it.')
        info('OpenClaw 2026.4.5 ships `openclaw mcp` with only `list` and `serve`.')
        info('Upgrade the gateway to 2026.7.1-2 or later, then re-run this command.')
        process.exit(1)
      }

      if (result.status === 'exists') {
        spin.info('The gateway already has a clawops MCP server configured.')
        info(`Pointing at ${result.url}. Replace it with: clawops mcp wire --rewire`)
        return
      }

      if (result.status === 'probe-failed') {
        // `openclaw mcp add` probes before saving, so nothing was written. The old code
        // wrote a config key nothing read and reported success regardless.
        spin.fail('The gateway could not connect to clawops. Nothing was changed.')
        failure(result.error)
        warn('clawops does not run on the gateway host. Start it where the gateway can reach it:')
        info(`  clawops mcp serve --http ${MCP_HTTP_PORT} --bind 0.0.0.0 --token <token>`)
        info(`Then re-run: clawops mcp wire --url ${result.url} --token <token>`)
        process.exit(1)
      }

      spin.succeed(
        result.rewired
          ? 'Re-wired the gateway to clawops — previous entry replaced.'
          : 'Gateway wired to clawops, and the connection was verified.',
      )
      success('The gateway\'s AI can now run clawops commands.')
      info('Try asking it: "check if my stack is healthy"')
      warn('The MCP server exposes destructive tools. Keep it bound where only the gateway can reach it.')
    } catch (err) {
      spin.fail('Failed to wire gateway MCP client.')
      failure(err instanceof Error ? err.message : String(err))
      process.exit(1)
    } finally {
      release()
      drainPool()
    }
  },
})

// ── mcp (root) ─────────────────────────────────────────────────────────────

export default defineCommand({
  meta: {
    name: 'mcp',
    description: 'MCP server operations',
  },
  args: {},
  subCommands: {
    serve: serveCmd,
    install: installCmd,
    wire: wireCmd,
  },
})
