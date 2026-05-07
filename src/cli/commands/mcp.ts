import { defineCommand } from 'citty'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export default defineCommand({
  meta: {
    name: 'mcp',
    description: 'MCP server operations (serve | install)',
  },
  args: {
    http: { type: 'string', description: 'HTTP port for standalone mode' },
    bind: { type: 'string', description: 'Bind address for HTTP mode' },
    'read-only': { type: 'boolean', description: 'Only register read toolset' },
    'no-destructive': { type: 'boolean', description: 'Filter out destructive tools' },
    toolsets: { type: 'string', description: 'Comma-separated toolsets to enable' },
    inspector: { type: 'boolean', description: 'Enable MCP inspector' },
    claude: { type: 'boolean', description: 'Install for Claude Desktop' },
    cursor: { type: 'boolean', description: 'Install for Cursor' },
    vscode: { type: 'boolean', description: 'Install for VS Code' },
    windsurf: { type: 'boolean', description: 'Install for Windsurf' },
    zed: { type: 'boolean', description: 'Install for Zed' },
  },
  async run({ args }) {
    const installFlags = ['claude', 'cursor', 'vscode', 'windsurf', 'zed'] as const
    const requestedClients = installFlags.filter((f) => Boolean(args[f]))

    if (requestedClients.length > 0) {
      for (const client of requestedClients) {
        installMcp(client)
        process.stderr.write(`Installed MCP config for: ${client}\n`)
      }
      return
    }

    // Serve mode
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

type McpClient = 'claude' | 'cursor' | 'vscode' | 'windsurf' | 'zed'

const CLAWOPS_ENTRY = {
  command: 'clawops',
  args: ['mcp', 'serve'],
  type: 'stdio',
}

function getConfigPath(client: McpClient): string {
  const home = os.homedir()
  switch (client) {
    case 'claude':
      return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
    case 'cursor':
      return path.join(home, '.cursor', 'mcp.json')
    case 'vscode':
      return path.join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json')
    case 'windsurf':
      return path.join(home, '.codeium', 'windsurf', 'mcp_config.json')
    case 'zed':
      return path.join(home, '.config', 'zed', 'settings.json')
  }
}

function installMcp(client: McpClient): void {
  const configPath = getConfigPath(client)
  const dir = path.dirname(configPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  let config: Record<string, unknown> = {}
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>
    } catch {
      // corrupt/empty file — start fresh
    }
  }

  if (client === 'zed') {
    // Zed nests MCP under context_servers
    const contextServers = (config['context_servers'] ?? {}) as Record<string, unknown>
    contextServers['clawops'] = CLAWOPS_ENTRY
    config['context_servers'] = contextServers
  } else {
    // Claude, Cursor, VS Code, Windsurf all use mcpServers top-level
    const mcpServers = (config['mcpServers'] ?? {}) as Record<string, unknown>
    mcpServers['clawops'] = CLAWOPS_ENTRY
    config['mcpServers'] = mcpServers
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8')
}
