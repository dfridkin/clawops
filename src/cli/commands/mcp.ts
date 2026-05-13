import { defineCommand } from 'citty'
import process from 'node:process'
import { success, failure, info } from '../../output/human.js'

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
  },
})
