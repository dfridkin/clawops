import { describe, it, expect, afterAll } from 'vitest'
import { serveMcp, authRequirement, isLoopbackBind, bearerFrom, MCP_HTTP_PORT } from '../../src/mcp/server.js'

// A real server on a real port. The existing http.test.ts mocks the transport, the HTTP
// module and the SDK, so it verifies which transport is selected — not what the server
// does. That is how a server with ONE transport for the whole process passed: every
// client after the first got "Server already initialized", while HTTP mode is documented
// as the multi-client one.

const PORT = 19871
const TOKEN = 'test-token'
let started = false

async function start(): Promise<void> {
  if (started) return
  void serveMcp({ port: PORT, bind: '127.0.0.1', token: TOKEN, readOnly: true })
  // Poll rather than sleep a fixed amount: a fixed wait is either flaky or slow.
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/`, { method: 'POST' })
      started = true
      return
    } catch {
      await new Promise((r) => setTimeout(r, 50))
    }
  }
  throw new Error('server did not start')
}

function initialize(headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${PORT}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      },
    }),
  })
}

const auth = { authorization: `Bearer ${TOKEN}` }

afterAll(() => { started = false })

describe('MCP HTTP server', () => {
  it('serves more than one client', async () => {
    await start()
    const first = await initialize(auth)
    const second = await initialize(auth)

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)

    const a = first.headers.get('mcp-session-id')
    const b = second.headers.get('mcp-session-id')
    expect(a).toBeTruthy()
    expect(b).toBeTruthy()
    expect(a).not.toBe(b)
  })

  it('rejects a request with no token', async () => {
    await start()
    const res = await initialize()
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain('Bearer')
  })

  it('rejects a wrong token', async () => {
    await start()
    expect((await initialize({ authorization: 'Bearer nope' })).status).toBe(401)
  })

  it('rejects a token of the right length but wrong value', async () => {
    // Guards the constant-time compare: same length takes the timingSafeEqual path rather
    // than the length short-circuit.
    await start()
    const sameLength = 'x'.repeat(TOKEN.length)
    expect((await initialize({ authorization: `Bearer ${sameLength}` })).status).toBe(401)
  })

  it('does not treat an unknown session id as a new session', async () => {
    // Answering it as new would hand the client a different server than the one it
    // initialized against, silently.
    await start()
    const res = await initialize({ ...auth, 'mcp-session-id': 'not-a-real-session' })
    expect(res.status).toBe(404)
  })
})

describe('authRequirement', () => {
  it('allows a loopback bind with no token', () => {
    expect(authRequirement('127.0.0.1', undefined).ok).toBe(true)
    expect(authRequirement('::1', undefined).ok).toBe(true)
  })

  it('refuses a non-loopback bind with no token', () => {
    // The server exposes every tool, clawops_destroy included, with no other auth.
    const r = authRequirement('0.0.0.0', undefined)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/--token/)
  })

  it('allows a non-loopback bind once a token is set', () => {
    expect(authRequirement('0.0.0.0', 'tok').ok).toBe(true)
  })

  it.each(['0.0.0.0', '::', '10.0.0.5', 'host.docker.internal', '172.17.0.1'])(
    'treats %s as reachable from elsewhere',
    (bind) => expect(isLoopbackBind(bind)).toBe(false),
  )
})

describe('bearerFrom', () => {
  it('reads a bearer token', () => {
    expect(bearerFrom('Bearer abc')).toBe('abc')
    expect(bearerFrom('bearer  abc  ')).toBe('abc')
  })

  it('returns undefined for anything else', () => {
    expect(bearerFrom(undefined)).toBeUndefined()
    expect(bearerFrom('')).toBeUndefined()
    expect(bearerFrom('Basic abc')).toBeUndefined()
    expect(bearerFrom('Bearer')).toBeUndefined()
  })
})

describe('MCP_HTTP_PORT', () => {
  it('is not the gateway port', async () => {
    const { GATEWAY_PORT } = await import('../../src/openclaw/run-flags.js')
    expect(MCP_HTTP_PORT).not.toBe(GATEWAY_PORT)
  })
})
