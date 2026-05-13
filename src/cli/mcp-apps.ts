// Shared MCP app registry — used by `clawops setup` (Step 8) and `clawops mcp install`.

import { execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export interface McpApp {
  id: string
  name: string
  configPath: () => string
  isInstalled: () => boolean
  /** Top-level key in the config file. Defaults to 'mcpServers'. Zed uses 'context_servers'. */
  configKey?: string
  /** Extra fields merged into the MCP entry object (e.g. Zed requires type: 'stdio'). */
  entryExtra?: Record<string, unknown>
}

export const MCP_APPS: McpApp[] = [
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    configPath: () => process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
      : path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json'),
    isInstalled: () => existsSync(
      process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support', 'Claude')
        : path.join(os.homedir(), '.config', 'Claude'),
    ),
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    configPath: () => path.join(os.homedir(), '.claude.json'),
    isInstalled: () => {
      if (existsSync(path.join(os.homedir(), '.claude.json'))) return true
      try { execSync('claude --version', { stdio: 'ignore' }); return true } catch { return false }
    },
  },
  {
    id: 'cursor',
    name: 'Cursor',
    configPath: () => path.join(os.homedir(), '.cursor', 'mcp.json'),
    isInstalled: () => existsSync(path.join(os.homedir(), '.cursor')),
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    configPath: () => path.join(os.homedir(), '.codeium', 'windsurf', 'mcp_config.json'),
    isInstalled: () => existsSync(path.join(os.homedir(), '.codeium', 'windsurf')),
  },
  {
    id: 'vscode',
    name: 'VS Code',
    configPath: () => process.platform === 'linux'
      ? path.join(os.homedir(), '.config', 'Code', 'User', 'mcp.json')
      : path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'mcp.json'),
    isInstalled: () => existsSync(
      process.platform === 'linux'
        ? path.join(os.homedir(), '.config', 'Code')
        : path.join(os.homedir(), 'Library', 'Application Support', 'Code'),
    ),
  },
  {
    id: 'zed',
    name: 'Zed',
    configPath: () => path.join(os.homedir(), '.config', 'zed', 'settings.json'),
    isInstalled: () => existsSync(path.join(os.homedir(), '.config', 'zed')),
    configKey: 'context_servers',
    entryExtra: { type: 'stdio' },
  },
]

export function buildMcpEntry(): { command: string; args: string[]; resolved: boolean } {
  try {
    const bin = execSync('which clawops', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (bin) return { command: bin, args: ['mcp', 'serve', '--read-only'], resolved: true }
  } catch { /* not on PATH */ }
  return { command: 'clawops', args: ['mcp', 'serve', '--read-only'], resolved: false }
}

export interface WriteResult {
  app: McpApp
  configPath: string
  ok: boolean
  error?: string
}

export function writeAppConfigs(apps: McpApp[], entry: { command: string; args: string[] }): WriteResult[] {
  return apps.map((app) => {
    const cfgPath = app.configPath()
    try {
      let config: Record<string, unknown> = {}
      if (existsSync(cfgPath)) {
        try {
          config = JSON.parse(readFileSync(cfgPath, 'utf-8')) as Record<string, unknown>
        } catch { /* corrupt — start fresh */ }
      }
      mkdirSync(path.dirname(cfgPath), { recursive: true })
      const key = app.configKey ?? 'mcpServers'
      const servers = (config[key] ?? {}) as Record<string, unknown>
      servers['clawops'] = { ...entry, ...(app.entryExtra ?? {}) }
      config[key] = servers
      writeFileSync(cfgPath, JSON.stringify(config, null, 2) + '\n', 'utf-8')
      return { app, configPath: cfgPath, ok: true }
    } catch (err) {
      return { app, configPath: cfgPath, ok: false, error: (err as Error).message }
    }
  })
}
