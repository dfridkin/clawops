// clawops_gateway_status and clawops_gateway_update: the same code as `clawops gateway
// status|update` (src/openclaw/gateway-ops.ts), so the two surfaces answer and refuse alike.

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { FakeSshSession } from '../helpers/ssh.js'
import { FAKE_CONN, makeFakeContext } from '../helpers/context.js'

vi.mock('../../src/cli/context.js', () => ({ buildContext: vi.fn() }))
vi.mock('../../src/transport/pool.js', () => ({ acquireSession: vi.fn(), drainPool: vi.fn() }))
vi.mock('../../src/mcp/tools/_conn.js', () => ({
  resolveConn: vi.fn(),
  okText: vi.fn((t: string) => ({ content: [{ type: 'text', text: t }] })),
  errText: vi.fn((t: string) => ({ content: [{ type: 'text', text: t }], isError: true })),
}))

// trimForMcp persists the full output under CLAWOPS_HOME; keep it out of the real one.
const home = mkdtempSync(path.join(tmpdir(), 'clawops-mcp-gateway-'))
process.env['CLAWOPS_HOME'] = home
afterAll(() => rmSync(home, { recursive: true, force: true }))

type ElicitResult = { action: 'accept' | 'decline' | 'cancel'; content?: { confirmed: boolean } }

function makeServer(opts: { elicitation?: boolean; answer?: ElicitResult } = {}) {
  const elicitInput = vi.fn().mockResolvedValue(opts.answer ?? { action: 'accept', content: { confirmed: true } })
  const server = {
    server: {
      getClientCapabilities: () => (opts.elicitation === false ? {} : { elicitation: {} }),
      elicitInput,
      notification: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as McpServer
  return { server, elicitInput }
}

function text(result: { content: unknown[] }): string {
  return (result.content[0] as { type: 'text'; text: string }).text
}

async function getMocks() {
  const { buildContext } = await import('../../src/cli/context.js')
  const { acquireSession } = await import('../../src/transport/pool.js')
  const { resolveConn } = await import('../../src/mcp/tools/_conn.js')
  return {
    buildContext: vi.mocked(buildContext),
    acquireSession: vi.mocked(acquireSession),
    resolveConn: vi.mocked(resolveConn),
  }
}

async function wire(session: FakeSshSession) {
  const { acquireSession } = await getMocks()
  acquireSession.mockResolvedValue({ session, release: vi.fn() } as never)
}

beforeEach(async () => {
  vi.clearAllMocks()
  const { buildContext, resolveConn } = await getMocks()
  buildContext.mockReturnValue(makeFakeContext())
  resolveConn.mockResolvedValue(FAKE_CONN)
})

describe('handleGatewayStatus', () => {
  it('reports a running container as docker describes it', async () => {
    const session = new FakeSshSession().respond(/docker inspect openclaw/, {
      stdout: '{"status":"running","started":"2026-09-30T00:00:00Z","image":"ghcr.io/openclaw/openclaw:2026.9.2"}',
    })
    await wire(session)

    const { handleGatewayStatus } = await import('../../src/mcp/tools/cli/gateway.js')
    const result = await handleGatewayStatus({ stackName: 'default' }, makeServer().server)

    expect(result.isError).toBeFalsy()
    const body = JSON.parse(text(result)) as Record<string, string>
    expect(body).toEqual({
      status: 'running',
      started: '2026-09-30T00:00:00Z',
      image: 'ghcr.io/openclaw/openclaw:2026.9.2',
    })
  })

  it('reports a missing container as "not running" — an answer, not an error', async () => {
    const session = new FakeSshSession().respond(/docker inspect openclaw/, {
      stderr: 'Error: No such object: openclaw',
      code: 1,
    })
    await wire(session)

    const { handleGatewayStatus } = await import('../../src/mcp/tools/cli/gateway.js')
    const result = await handleGatewayStatus({ stackName: 'default' }, makeServer().server)

    expect(result.isError).toBeFalsy()
    expect((JSON.parse(text(result)) as { status: string }).status).toBe('not running')
  })

  it('reports that docker could not be asked, never "not running"', async () => {
    // Reporting "not running" when docker refused the question would be a statement about the
    // gateway, when the truth is that clawops could not ask. Same words as the CLI.
    const session = new FakeSshSession().respond(/inspect/, {
      stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
      code: 1,
    })
    await wire(session)

    const { handleGatewayStatus } = await import('../../src/mcp/tools/cli/gateway.js')
    const result = await handleGatewayStatus({ stackName: 'default' }, makeServer().server)

    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/^Could not ask docker about the gateway: Cannot connect to the Docker daemon/)
    expect(text(result)).not.toContain('not running')
  })
})

/** A host on which an update to `target` goes through cleanly. */
function healthyHost(current = 'ghcr.io/openclaw/openclaw:2026.9.2'): FakeSshSession {
  return new FakeSshSession()
    .respond(/.*/, { stdout: '' })
    .respond(/docker pull/, { stdout: 'pulled' })
    .respond(/\{\{\.Config\.Image\}\}/, { stdout: current })
    .respond(/PortBindings/, { stdout: '{"18789/tcp":[{"HostIp":"127.0.0.1"}]}' })
    .respond(/backup sqlite create/, { stdout: '{"ok":true,"snapshotPath":"/home/node/.openclaw/snapshots/s1"}' })
    .respond(/database preflight/, { stdout: '{"targetVersion":15,"foundVersion":15,"status":"exact"}' })
    .respond(/startupz/, { stdout: '{"ok":true,"status":"started"}' })
}

describe('handleGatewayUpdate', () => {
  it('refuses a moving tag with the CLI\'s exact words, before touching the host', async () => {
    // The CLI's refusal, captured by running the CLI itself rather than copying its text here
    // — a copied string would keep passing after the two surfaces drifted apart.
    const cliSession = new FakeSshSession().respond(/.*/, { stdout: '' })
    await wire(cliSession)
    const { default: cmd } = await import('../../src/cli/commands/gateway.js')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cliError = await (cmd.run as (c: any) => Promise<void>)({
      args: { _: ['update', 'latest'], stack: undefined, channel: undefined, json: false },
    }).then(() => undefined, (e: unknown) => e as Error)
    expect(cliError?.message).toMatch(/moving tag/)

    const { acquireSession } = await getMocks()
    acquireSession.mockClear()
    const { server, elicitInput } = makeServer()
    const { handleGatewayUpdate } = await import('../../src/mcp/tools/cli/gateway.js')
    const result = await handleGatewayUpdate({ stackName: 'default', version: 'latest', yes: false }, server)

    expect(result.isError).toBe(true)
    expect(text(result)).toBe(cliError!.message)
    // Refused before anything else: no session, no confirmation asked for.
    expect(acquireSession).not.toHaveBeenCalled()
    expect(elicitInput).not.toHaveBeenCalled()
  })

  it('refuses an empty version instead of updating to the recommended pin', async () => {
    const { acquireSession } = await getMocks()
    acquireSession.mockClear()
    const { server, elicitInput } = makeServer()
    const { handleGatewayUpdate } = await import('../../src/mcp/tools/cli/gateway.js')
    const result = await handleGatewayUpdate({ stackName: 'default', version: '  ', yes: true }, server)

    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/version is required/)
    expect(acquireSession).not.toHaveBeenCalled()
    expect(elicitInput).not.toHaveBeenCalled()
  })

  it('asks before updating, naming the stack and both versions, and does nothing when declined', async () => {
    const session = healthyHost()
    await wire(session)
    const { server, elicitInput } = makeServer({ answer: { action: 'decline' } })

    const { handleGatewayUpdate } = await import('../../src/mcp/tools/cli/gateway.js')
    const result = await handleGatewayUpdate({ stackName: 'default', version: '2026.9.5', yes: false }, server)

    expect(elicitInput).toHaveBeenCalledOnce()
    const message = (elicitInput.mock.calls[0]![0] as { message: string }).message
    expect(message).toContain('"default"')
    expect(message).toContain('from 2026.9.2')
    expect(message).toContain('to 2026.9.5')
    expect(text(result)).toMatch(/Cancelled/)
    expect(session.execCalls().filter((c) => /docker pull|docker run|backup sqlite/.test(c))).toEqual([])
  })

  it('tells a client that cannot confirm to call again with yes: true, and changes nothing', async () => {
    const session = healthyHost()
    await wire(session)
    const { server, elicitInput } = makeServer({ elicitation: false })

    const { handleGatewayUpdate } = await import('../../src/mcp/tools/cli/gateway.js')
    const result = await handleGatewayUpdate({ stackName: 'default', version: '2026.9.5', yes: false }, server)

    expect(result.isError).toBeFalsy()
    expect(text(result)).toContain('`yes: true`')
    expect(text(result)).toContain('updating the gateway to 2026.9.5')
    expect(elicitInput).not.toHaveBeenCalled()
    expect(session.execCalls().filter((c) => /docker pull|docker run|backup sqlite/.test(c))).toEqual([])
  })

  it('with yes: true, updates without asking: pull, snapshot, preflight, run, startup gate', async () => {
    const session = healthyHost()
    await wire(session)
    const { server, elicitInput } = makeServer()

    const { handleGatewayUpdate } = await import('../../src/mcp/tools/cli/gateway.js')
    const result = await handleGatewayUpdate({ stackName: 'default', version: '2026.9.5', yes: true }, server)

    expect(elicitInput).not.toHaveBeenCalled()
    expect(result.isError).toBeFalsy()
    expect(text(result)).toBe('Gateway updated to 2026.9.5.')
    const calls = session.execCalls()
    const at = (re: RegExp) => calls.findIndex((c) => re.test(c))
    expect(calls.find((c) => c.includes('docker pull'))).toContain('openclaw:2026.9.5')
    expect(at(/docker pull/)).toBeLessThan(at(/backup sqlite create/))
    expect(at(/backup sqlite create/)).toBeLessThan(at(/database preflight/))
    // The snapshot runs in a container with the state mounted at /home/node/.openclaw, so its
    // repository must be a path in there. The host path does not exist in the container, and
    // every real update refused with "EACCES during mkdir" until the e2e ran one.
    expect(calls.find((c) => c.includes('backup sqlite create'))).toContain('--repository /home/node/.openclaw/snapshots')
    // ...and preflight reads the snapshot at the path the container reported.
    expect(calls.find((c) => c.includes('database preflight'))).toContain('/home/node/.openclaw/snapshots/s1/database.sqlite')
    expect(at(/database preflight/)).toBeLessThan(at(/--name openclaw/))
    expect(calls.find((c) => c.includes('--name openclaw'))).toContain('127.0.0.1:18789')
    expect(at(/startupz/)).toBeGreaterThan(at(/--name openclaw/))
  })

  it('refuses an incompatible state database in the CLI\'s words, keeping the snapshot', async () => {
    const session = healthyHost().respond(/database preflight/, {
      stdout: '{"targetVersion":15,"foundVersion":16,"status":"newer"}',
    })
    await wire(session)

    const { handleGatewayUpdate } = await import('../../src/mcp/tools/cli/gateway.js')
    const result = await handleGatewayUpdate({ stackName: 'default', version: '2026.9.5', yes: true }, makeServer().server)

    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/^Refusing to upgrade to 2026\.9\.5: /)
    expect(text(result)).toContain('A snapshot of the current state was kept at /var/lib/clawops/openclaw/snapshots/s1.')
    expect(session.execCalls().some((c) => c.includes('--name openclaw'))).toBe(false)
  })
})
