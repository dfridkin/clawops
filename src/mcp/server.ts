// MCP server — per SPEC.md §7.

import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
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

/** Start the MCP server. Uses HTTP when --http <port> is given, stdio otherwise. */
export async function serveMcp(opts: McpServeOpts): Promise<void> {
  const { version } = await import('../../package.json', { assert: { type: 'json' } })
  const server = new McpServer({ name: 'clawops', version })

  registerTools(server, opts)
  registerResources(server)
  registerPrompts(server)

  if (opts.port) {
    const bind = opts.bind ?? '127.0.0.1'
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() })
    const httpServer = createServer((req, res) => { void transport.handleRequest(req, res) })

    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject)
      httpServer.listen(opts.port!, bind, resolve)
    })
    process.stderr.write(`[clawops] MCP HTTP server listening on ${bind}:${opts.port}\n`)

    await server.connect(transport)
    await new Promise<void>((resolve) => httpServer.once('close', resolve))
  } else {
    const transport = new StdioServerTransport()
    await server.connect(transport)

    // Keep process alive until transport closes
    await new Promise<void>((resolve) => {
      server.server.onclose = resolve
    })
  }
}
