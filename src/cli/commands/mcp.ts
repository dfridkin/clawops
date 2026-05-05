import { defineCommand } from 'citty'

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
  async run() {
    throw new Error('clawops mcp: not yet implemented (M5)')
  },
})
