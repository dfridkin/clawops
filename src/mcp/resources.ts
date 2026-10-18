// MCP resources — per SPEC.md §7.3.

import { readFileSync } from 'node:fs'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getConfig } from '../config/store.js'
import { lastRunPath } from './tools/_trim.js'

export function registerResources(server: McpServer): void {
  // ── clawops://current-context ───────────────────────────────────────────────
  server.registerResource(
    'current-context',
    'clawops://current-context',
    { description: 'Active stack name, provider, and region' },
    async () => {
      const config = getConfig()
      const stackName = config?.defaults.stack ?? 'unknown'
      const stack = config?.stacks[stackName]
      const data = {
        stackName,
        provider: stack?.provider ?? config?.defaults.provider ?? 'unknown',
        region: stack?.region ?? 'unknown',
      }
      return {
        contents: [{
          uri: 'clawops://current-context',
          mimeType: 'application/json',
          text: JSON.stringify(data, null, 2),
        }],
      }
    },
  )

  // ── clawops://stacks ────────────────────────────────────────────────────────
  server.registerResource(
    'stacks',
    'clawops://stacks',
    { description: 'All configured stacks' },
    async () => {
      const config = getConfig()
      const stacks = config
        ? Object.entries(config.stacks).map(([name, cfg]) => ({
            name,
            provider: cfg.provider,
            region: cfg.region,
            isDefault: name === config.defaults.stack,
          }))
        : []
      return {
        contents: [{
          uri: 'clawops://stacks',
          mimeType: 'application/json',
          text: JSON.stringify({ stacks }, null, 2),
        }],
      }
    },
  )

  // ── clawops://stacks/{name}/last-run ────────────────────────────────────────
  server.registerResource(
    'stack-last-run',
    new ResourceTemplate('clawops://stacks/{name}/last-run', { list: undefined }),
    { description: 'Full Pulumi output from the last up/destroy run for a stack' },
    async (uri, { name }) => {
      const stackName = String(Array.isArray(name) ? name[0] : name)
      const filePath = lastRunPath(stackName)
      let text: string
      try {
        if (!filePath) throw new Error('not a stack name')
        const raw = readFileSync(filePath, 'utf-8')
        const parsed = JSON.parse(raw) as { output?: string }
        text = parsed.output ?? '(no output recorded)'
      } catch {
        text = `No last-run output found for stack "${stackName}".`
      }
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'text/plain',
          text,
        }],
      }
    },
  )
}
