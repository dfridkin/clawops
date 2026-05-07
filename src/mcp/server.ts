// MCP server — per SPEC.md §7.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { UsageError } from '../errors/index.js'
import { registerTools } from './tools/registry.js'
import { registerResources } from './resources.js'
import { registerPrompts } from './prompts.js'

export interface McpServeOpts {
  port?: number
  bind?: string
  readOnly?: boolean
  noDestructive?: boolean
  toolsets?: string[]
  inspector?: boolean
}

/** Start the MCP server (stdio by default). HTTP deferred to M6. */
export async function serveMcp(opts: McpServeOpts): Promise<void> {
  if (opts.port) {
    throw new UsageError('HTTP transport not yet implemented (M6). Omit --http to use stdio.')
  }

  const { version } = await import('../../package.json', { assert: { type: 'json' } })
  const server = new McpServer({ name: 'clawops', version })

  registerTools(server, opts)
  registerResources(server)
  registerPrompts(server)

  const transport = new StdioServerTransport()
  await server.connect(transport)

  // Keep process alive until transport closes
  await new Promise<void>((resolve) => {
    server.server.onclose = resolve
  })
}
