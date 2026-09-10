// MCP server — per SPEC.md §7.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { registerTools } from './tools/registry.js'
import { registerResources } from './resources.js'
import { registerPrompts } from './prompts.js'

export interface McpServeOpts {
  port?: number
  bind?: string
  /** Bearer token required on every HTTP request. Required unless bound to loopback. */
  token?: string
  readOnly?: boolean
  noDestructive?: boolean
  toolsets?: string[]
  inspector?: boolean
}

/**
 * Default port for `clawops mcp serve --http`.
 *
 * Adjacent to the gateway's 18789 so the pair is recognisable in a firewall rule, and not
 * the same port — they are two different servers on the same host.
 */
export const MCP_HTTP_PORT = 18790

/** Addresses where only something already on this host can reach the server. */
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])

export function isLoopbackBind(bind: string): boolean {
  return LOOPBACK.has(bind)
}

/**
 * Decide whether this server may start.
 *
 * The HTTP server exposes the full tool surface — `clawops_destroy` included — with no
 * authentication of its own. On loopback that is bounded by who can already run commands on
 * the host. Bound anywhere else it is a control plane for someone else's cloud account,
 * reachable by anyone the firewall admits, so a token is required rather than advised.
 */
export function authRequirement(
  bind: string,
  token: string | undefined,
): { ok: true } | { ok: false; error: string } {
  if (isLoopbackBind(bind) || token) return { ok: true }
  return {
    ok: false,
    error:
      `Refusing to serve MCP on ${bind} without a token. This server exposes every clawops ` +
      `tool, including destructive ones, and has no other authentication. Pass --token <value> ` +
      `(or set CLAWOPS_MCP_TOKEN), or bind to 127.0.0.1 and reach it through an SSH tunnel.`,
  }
}

/** Constant-time compare, so a wrong token cannot be found one byte at a time. */
function tokenMatches(expected: string, presented: string): boolean {
  const a = Buffer.from(expected)
  const b = Buffer.from(presented)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export function bearerFrom(header: string | undefined): string | undefined {
  if (!header) return undefined
  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim())
  return match?.[1]?.trim()
}

/** Start the MCP server. Uses HTTP when --http <port> is given, stdio otherwise. */
export async function serveMcp(opts: McpServeOpts): Promise<void> {
  const { version } = await import('../../package.json', { assert: { type: 'json' } })

  const makeServer = (): McpServer => {
    const server = new McpServer({ name: 'clawops', version })
    registerTools(server, opts)
    registerResources(server)
    registerPrompts(server)
    return server
  }

  if (opts.port) {
    const bind = opts.bind ?? '127.0.0.1'
    const token = opts.token ?? process.env['CLAWOPS_MCP_TOKEN']

    const allowed = authRequirement(bind, token)
    if (!allowed.ok) throw new Error(allowed.error)

    // One transport per session, not one for the process.
    //
    // A single shared transport is initialized by whichever client connects first; every
    // client after it — a second editor, a reconnect after a dropped connection, the
    // gateway's own probe — is answered "Server already initialized" and cannot connect.
    // HTTP mode exists precisely for the multi-client case.
    const sessions = new Map<string, StreamableHTTPServerTransport>()

    const httpServer = createServer((req, res) => {
      void handleHttp(req, res, sessions, makeServer, token)
    })

    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject)
      httpServer.listen(opts.port!, bind, resolve)
    })
    process.stderr.write(
      `[clawops] MCP HTTP server listening on ${bind}:${opts.port}` +
        `${token ? ' (bearer token required)' : ' (loopback, no token)'}\n`,
    )

    await new Promise<void>((resolve) => httpServer.once('close', resolve))
  } else {
    const server = makeServer()
    const transport = new StdioServerTransport()
    await server.connect(transport)

    // Keep process alive until transport closes
    await new Promise<void>((resolve) => {
      server.server.onclose = resolve
    })
  }
}

async function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  sessions: Map<string, StreamableHTTPServerTransport>,
  makeServer: () => McpServer,
  token: string | undefined,
): Promise<void> {
  if (token) {
    const presented = bearerFrom(req.headers['authorization'])
    if (!presented || !tokenMatches(token, presented)) {
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' })
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Unauthorized' },
          id: null,
        }),
      )
      return
    }
  }

  const sessionId = req.headers['mcp-session-id']
  const existing = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined
  if (existing) {
    await existing.handleRequest(req, res)
    return
  }

  // A session id we do not know is not a new session: replaying it would silently hand the
  // client a different server than the one it initialized against.
  if (typeof sessionId === 'string') {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unknown session' },
        id: null,
      }),
    )
    return
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id: string) => { sessions.set(id, transport) },
  })
  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId)
  }

  await makeServer().connect(transport)
  await transport.handleRequest(req, res)
}
