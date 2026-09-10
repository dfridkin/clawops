import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FakeSshSession } from '../helpers/ssh.js'
import {
  wireGatewayMcp, defaultGatewayMcpUrl, GATEWAY_MCP_NAME,
} from '../../src/cli/mcp-wire.js'

// WO-28 wrote `gateway.mcpClients.clawops` and reported success. That key does not exist in
// OpenClaw — verified against the config schemas of 2026.7.1-2 and 2026.9.2 — and the entry
// it wrote pointed at `command: "clawops"` over stdio, which spawns inside the gateway
// container where clawops is not installed. Nothing was ever wired on any version.
//
// These assert the corrected behaviour: delegate to `openclaw mcp add`, which probes the
// server before saving, so "wired" means the gateway actually connected.

const SIGNAL = new AbortController().signal

/** The real `mcp add` call, not the `--help` capability probe that precedes it. */
const isAdd = (cmd: string) => cmd.includes('mcp add') && !cmd.includes('--help')
const addCall = (session: FakeSshSession) => session.execCalls().find(isAdd)

/** A host where no clawops entry exists yet. */
function freshHost(): FakeSshSession {
  return new FakeSshSession()
    .respond(/mcp add --help/, { stdout: 'Usage: openclaw mcp add', code: 0 })
    .respond(/mcp show/, { stdout: '', stderr: 'No MCP server named', code: 1 })
    .respond(/mcp add (?!--help)/, { stdout: 'Saved MCP server "clawops"', code: 0 })
    .respond(/mcp unset/, { code: 0 })
    .respond(/mcp reload/, { stdout: 'Disposed cached MCP runtimes.', code: 0 })
}

/** A host that already has one. */
function wiredHost(): FakeSshSession {
  return freshHost().respond(/mcp show/, { stdout: '{"url":"http://old/"}', code: 0 })
}

beforeEach(() => vi.clearAllMocks())

describe('wireGatewayMcp', () => {
  it('delegates to `openclaw mcp add` rather than writing config itself', async () => {
    const session = freshHost()
    const result = await wireGatewayMcp(session, SIGNAL)

    expect(result.status).toBe('wired')
    const add = addCall(session)!
    expect(add).toContain('docker exec openclaw openclaw mcp add clawops')
    // Never the key WO-28 invented.
    expect(session.execCalls().join(' ')).not.toContain('mcpClients')
  })

  it('never passes --no-probe', async () => {
    // The load-bearing property of the whole fix. `openclaw mcp add` probes the server
    // before saving, which is why "wired" can mean the gateway connected rather than a file
    // was written. --no-probe would save the entry regardless and put clawops straight back
    // to reporting a wiring it never verified.
    const session = freshHost()
    await wireGatewayMcp(session, SIGNAL, { token: 'tok', url: 'http://x/' })
    expect(session.execCalls().join(' ')).not.toContain('--no-probe')
  })

  it('uses the HTTP transport, not stdio', async () => {
    // stdio would spawn `clawops` inside the container, where it does not exist.
    const session = freshHost()
    await wireGatewayMcp(session, SIGNAL)
    const add = addCall(session)!
    expect(add).toContain('--transport streamable-http')
    expect(add).not.toContain('--command')
  })

  it('points the gateway at the host, not at its own loopback', async () => {
    // Inside the container, 127.0.0.1 is the container.
    expect(defaultGatewayMcpUrl()).toContain('host.docker.internal')
    expect(defaultGatewayMcpUrl()).not.toContain('127.0.0.1')
    expect(defaultGatewayMcpUrl(9999)).toBe('http://host.docker.internal:9999/')
  })

  it('sends the bearer token as a header when given one', async () => {
    const session = freshHost()
    await wireGatewayMcp(session, SIGNAL, { token: 'sekret' })
    const add = addCall(session)!
    expect(add).toContain('Authorization=Bearer sekret')
  })

  it('sends no header when there is no token', async () => {
    const session = freshHost()
    await wireGatewayMcp(session, SIGNAL)
    expect(addCall(session)).not.toContain('--header')
  })

  it('reloads so the change takes effect without a gateway restart', async () => {
    const session = freshHost()
    await wireGatewayMcp(session, SIGNAL)
    expect(session.execCalls().some((c) => c.includes('mcp reload'))).toBe(true)
    // The old implementation restarted the whole gateway to apply a config write.
    expect(session.execCalls().join(' ')).not.toContain('docker run')
  })

  it('reports the probe failure and does not claim to have wired anything', async () => {
    const session = freshHost().respond(/mcp add (?!--help)/, {
      stdout: '', stderr: 'MCP probe failed for "clawops": ECONNREFUSED', code: 1,
    })
    const result = await wireGatewayMcp(session, SIGNAL)

    expect(result.status).toBe('probe-failed')
    if (result.status === 'probe-failed') expect(result.error).toContain('ECONNREFUSED')
    // Nothing to reload — the gateway saved nothing.
    expect(session.execCalls().some((c) => c.includes('mcp reload'))).toBe(false)
  })

  it('refuses to replace an existing entry unless asked', async () => {
    const session = wiredHost()
    const result = await wireGatewayMcp(session, SIGNAL)

    expect(result.status).toBe('exists')
    expect(session.execCalls().some(isAdd)).toBe(false)
  })

  it('removes the old entry before adding, when rewiring', async () => {
    // `openclaw mcp add` refuses a name that already exists, so a rewire that skipped the
    // unset would fail while looking like it had been asked for.
    const session = wiredHost()
    const result = await wireGatewayMcp(session, SIGNAL, { rewire: true })

    expect(result).toMatchObject({ status: 'wired', rewired: true })
    const calls = session.execCalls()
    const unset = calls.findIndex((c) => c.includes('mcp unset'))
    const add = calls.findIndex(isAdd)
    expect(unset).toBeGreaterThanOrEqual(0)
    expect(add).toBeGreaterThanOrEqual(0)
    expect(unset).toBeLessThan(add)
  })

  it('reports a failed unset rather than adding on top of it', async () => {
    const session = wiredHost().respond(/mcp unset/, { stderr: 'permission denied', code: 1 })
    const result = await wireGatewayMcp(session, SIGNAL, { rewire: true })

    expect(result.status).toBe('probe-failed')
    expect(session.execCalls().some(isAdd)).toBe(false)
  })

  it('quotes the url so a crafted value cannot break out of the command', async () => {
    // Asserted by running the produced command through a real shell rather than pattern-
    // matching it. Grepping for the payload fails either way: the dangerous characters are
    // still present in a correctly quoted command, just inert.
    const payload = "http://x/'; touch /tmp/clawops-pwned; '"
    const session = freshHost()
    await wireGatewayMcp(session, SIGNAL, { url: payload })

    const add = addCall(session)!
    const quoted = /--url (('[^']*'|\\')+)/.exec(add)?.[1]
    expect(quoted, 'no --url argument found').toBeDefined()

    const { execFileSync } = await import('node:child_process')
    const seen = execFileSync('sh', ['-c', `printf '%s' ${quoted!}`], { encoding: 'utf-8' })
    expect(seen).toBe(payload)
  })

  it('asks the gateway whether it can wire before trying', async () => {
    // OpenClaw 2026.4.5 ships `openclaw mcp` with only `list` and `serve`. Asked of the
    // binary, not inferred from a version string: WO-28's `>= 2026.4` gate was invented the
    // same way and gated on a capability that never existed.
    const session = freshHost().respond(/mcp add --help/, {
      stderr: "error: unknown command 'add'", code: 1,
    })
    const result = await wireGatewayMcp(session, SIGNAL)

    expect(result.status).toBe('unsupported')
    expect(session.execCalls().some(isAdd)).toBe(false)
    expect(session.execCalls().some((c) => c.includes('mcp unset'))).toBe(false)
  })

  it('stores under a stable name', () => {
    expect(GATEWAY_MCP_NAME).toBe('clawops')
  })
})
