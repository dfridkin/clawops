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
    bind: { type: 'string', description: 'Bind address for HTTP mode' },
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
    force: { type: 'boolean', description: 'Apply even if gateway version is below minimum' },
  },
  async run({ args }) {
    const { buildContext } = await import('../context.js')
    const { acquireSession, drainPool } = await import('../../transport/pool.js')
    const { extractBaseOutputs } = await import('../../pulumi/outputs.js')
    const { wireGatewayMcp } = await import('../mcp-wire.js')

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
      spin.text = 'Reading gateway config...'
      const result = await wireGatewayMcp(session, ac.signal, { force: Boolean(args.force) })

      if (result.status === 'version-blocked') {
        spin.fail('Gateway version is too old for MCP client support.')
        warn(`Gateway version ${result.version} requires at least 2026.4 for MCP client support.`)
        info('Upgrade OpenClaw and re-run, or bypass with: clawops mcp wire --force')
        process.exit(1)
      }

      if (result.rewired) {
        spin.succeed('Re-wiring clawops MCP client — previous entry replaced.')
      } else {
        spin.succeed('Gateway MCP client wired.')
      }
      success('The gateway\'s AI can now run clawops commands.')
      info('Try asking it: "check if my stack is healthy"')
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
