// clawops_migrate — moving a 1.x deployment onto 2.0, from an agent.
//
// The tool and `clawops migrate` run one flow (src/openclaw/migrate-flow.ts). The refusals are
// compared against what the CLI actually says on the same input, not against restated strings.
// The host is a FakeSshSession; nothing here opens a real connection.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { withTempConfig } from '../helpers/config.js'
import { makeFakeContext, FAKE_CONN } from '../helpers/context.js'
import { FakeSshSession } from '../helpers/ssh.js'

vi.mock('../../src/cli/context.js', () => ({ buildContext: vi.fn() }))
vi.mock('../../src/transport/ssh.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/transport/ssh.js')>()),
  connect: vi.fn(),
}))
vi.mock('../../src/transport/conn.js', () => ({ resolveConn: vi.fn() }))
const prompt = vi.hoisted(() => vi.fn())
vi.mock('inquirer', () => ({ default: { prompt } }))

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- citty's run() takes a loosely typed context
type AnyRunFn = (ctx: any) => Promise<void>

const V1_IMAGE = 'ghcr.io/openclaw/openclaw:2026.7.1-2'
const V2_IMAGE = 'ghcr.io/openclaw/openclaw:2026.9.2'

/** A host running `image`, on which every migration step succeeds. */
function host(image: string): FakeSshSession {
  return new FakeSshSession()
    .respond(/docker inspect openclaw/, { stdout: `${image}\n` })
    .respond(/backup create/, { stdout: '{"ok":true}' })
    .respond(/^ls /, { stdout: 'identity state workspace\n' })
    .respond(/startupz/, { stdout: '{"ok":true,"status":"started"}' })
    .respond(/device\.json/, { stdout: '{"deviceId":"dev-1"}' })
}

function server(opts: { elicitation?: boolean; action?: 'accept' | 'decline' } = {}) {
  const elicitInput = vi.fn().mockResolvedValue({ action: opts.action ?? 'accept', content: { confirmed: true } })
  const s = {
    server: {
      getClientCapabilities: () => (opts.elicitation === false ? {} : { elicitation: {} }),
      elicitInput,
      notification: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as McpServer
  return { s, elicitInput }
}

function text(r: CallToolResult): string {
  return (r.content[0] as { type: 'text'; text: string }).text
}

/** Destructive commands: any of these on the host means the migration got past its refusals. */
function touched(session: FakeSshSession): string[] {
  return session.execCalls().filter((c) => /backup create|docker cp|docker stop|docker rm|docker run|base64 -d/.test(c))
}

async function mocks() {
  const { buildContext } = await import('../../src/cli/context.js')
  const { connect } = await import('../../src/transport/ssh.js')
  const { resolveConn } = await import('../../src/transport/conn.js')
  return { buildContext: vi.mocked(buildContext), connect: vi.mocked(connect), resolveConn: vi.mocked(resolveConn) }
}

async function useHost(session: FakeSshSession) {
  const m = await mocks()
  m.buildContext.mockReturnValue(makeFakeContext())
  m.resolveConn.mockResolvedValue(FAKE_CONN)
  m.connect.mockResolvedValue(session)
  return m
}

async function handler() {
  const { handleMigrate } = await import('../../src/mcp/tools/cli/migrate.js')
  return handleMigrate
}

/** Run `clawops migrate` with these args; return what it said and how it ended. */
async function runCli(args: Record<string, unknown>): Promise<{ said: string; ended: string }> {
  const { default: cmd } = await import('../../src/cli/commands/migrate.js')
  const said: string[] = []
  const push = (...a: unknown[]) => { said.push(a.join(' ').replace(/^.*?[✓✗⚠ℹ]\s+/u, '')) }
  const spies = [
    vi.spyOn(console, 'error').mockImplementation(push),
    vi.spyOn(console, 'warn').mockImplementation(push),
    vi.spyOn(console, 'log').mockImplementation(push),
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`)
    }) as never),
  ]
  try {
    await (cmd.run as AnyRunFn)({ args: { _: [], yes: true, ...args } })
    return { said: said.join('\n'), ended: 'returned' }
  } catch (err) {
    return { said: said.join('\n'), ended: (err as Error).message }
  } finally {
    for (const spy of spies) spy.mockRestore()
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('clawops migrate — the CLI asks the same question', () => {
  it('without --yes, asks the question the tool asks, and touches nothing when declined', async () => {
    const session = host(V1_IMAGE)
    await useHost(session)
    prompt.mockResolvedValue({ confirmed: false })

    const { ended } = await runCli({ yes: false })
    expect(ended).toBe('returned')
    expect(prompt).toHaveBeenCalledTimes(1)

    const { migrationQuestion } = await import('../../src/openclaw/migrate-flow.js')
    const asked = (prompt.mock.calls[0]![0] as Array<{ message: string }>)[0]!.message
    expect(asked).toBe(migrationQuestion({ stackName: makeFakeContext().stackName, version: '2026.9.2' }))
    expect(touched(session)).toEqual([])
  })

  it('with --yes, does not ask', async () => {
    const session = host(V1_IMAGE)
    await useHost(session)
    await runCli({ yes: true })
    expect(prompt).not.toHaveBeenCalled()
    expect(touched(session).length).toBeGreaterThan(0)
  })
})

describe('clawops_migrate — confirmation (R19)', () => {
  it('asks first, naming the stack and the target version', async () => {
    const session = host(V1_IMAGE)
    await useHost(session)
    await withTempConfig(async () => {
      const { s, elicitInput } = server()
      const r = await (await handler())({ yes: false }, s)
      expect(elicitInput).toHaveBeenCalledOnce()
      const message = (elicitInput.mock.calls[0]![0] as { message: string }).message
      expect(message).toMatch(/"default"/)
      expect(message).toMatch(/2026\.9\.2/)
      expect(r.isError).toBeFalsy()
      expect(text(r)).toMatch(/Migrated to the 2\.0 runtime contract/)
    })
  })

  it('touches nothing when the user declines', async () => {
    const session = host(V1_IMAGE)
    const { connect } = await useHost(session)
    await withTempConfig(async () => {
      const { s } = server({ action: 'decline' })
      const r = await (await handler())({ yes: false }, s)
      expect(text(r)).toMatch(/Nothing was changed/)
      expect(connect).not.toHaveBeenCalled()
      expect(touched(session)).toEqual([])
    })
  })

  it('tells a client that cannot be asked to call again with yes: true, and touches nothing', async () => {
    const session = host(V1_IMAGE)
    const { connect } = await useHost(session)
    await withTempConfig(async () => {
      const { s, elicitInput } = server({ elicitation: false })
      const r = await (await handler())({ yes: false }, s)
      expect(text(r)).toMatch(/call this tool again with\s+`yes: true`/)
      expect(elicitInput).not.toHaveBeenCalled()
      expect(connect).not.toHaveBeenCalled()
    })
  })

  it('does not ask when yes: true, and runs the migration on its own connection', async () => {
    const session = host(V1_IMAGE)
    await useHost(session)
    await withTempConfig(async () => {
      const { s, elicitInput } = server({ elicitation: false })
      const r = await (await handler())({ yes: true }, s)
      expect(elicitInput).not.toHaveBeenCalled()
      expect(r.isError).toBeFalsy()
      expect(text(r)).toMatch(/Pre-migration backup: \/tmp\/clawops-premigration\.tar\.gz/)
      expect(session.execCalls().some((c) => c.includes(`docker run`) && c.includes('openclaw:2026.9.2'))).toBe(true)
      expect(session.closed).toBe(true)
    })
  })
})

describe('clawops_migrate — refuses what the CLI refuses, in its words', () => {
  it('refuses an unsupported target version before asking or connecting', async () => {
    const session = host(V1_IMAGE)
    const { connect } = await useHost(session)
    await withTempConfig(async () => {
      const cli = await runCli({ 'openclaw-version': '2026.7.1' })
      const { s, elicitInput } = server()
      const r = await (await handler())({ openclawVersion: '2026.7.1', yes: false }, s)
      expect(r.isError).toBe(true)
      expect(text(r)).toBe(cli.ended)
      expect(cli.ended).toMatch(/2026\.7\.1/)
      expect(elicitInput).not.toHaveBeenCalled()
      expect(connect).not.toHaveBeenCalled()
    })
  })

  it('refuses a stack already on 2.x, without backing up, stopping or rewriting anything', async () => {
    const cliHost = host(V2_IMAGE)
    await useHost(cliHost)
    await withTempConfig(async () => {
      const cli = await runCli({})
      expect(cli.said).toMatch(/already runs .*2026\.9\.2/)
      expect(cli.ended).toBe('process.exit(0)')
      expect(touched(cliHost)).toEqual([])

      const session = host(V2_IMAGE)
      await useHost(session)
      const { s } = server()
      const r = await (await handler())({ yes: true }, s)
      expect(text(r)).toBe(cli.said)
      expect(text(r)).toMatch(/clawops gateway update/)
      expect(touched(session)).toEqual([])
    })
  })

  it('still migrates a 1.x stack (the 2.x refusal is not a blanket one)', async () => {
    const session = host(V1_IMAGE)
    await useHost(session)
    await withTempConfig(async () => {
      const { s } = server()
      const r = await (await handler())({ yes: true }, s)
      expect(text(r)).toMatch(/Migrated/)
      expect(touched(session).some((c) => c.includes('docker stop'))).toBe(true)
    })
  })

  it('reports a failed backup as an error, and the CLI says the same', async () => {
    const cliHost = host(V1_IMAGE).respond(/backup create/, { code: 1, stderr: 'archive verification failed' })
    await useHost(cliHost)
    await withTempConfig(async () => {
      const cli = await runCli({})
      expect(cli.ended).toBe('process.exit(1)')

      const session = host(V1_IMAGE).respond(/backup create/, { code: 1, stderr: 'archive verification failed' })
      await useHost(session)
      const r = await (await handler())({ yes: true }, server().s)
      expect(r.isError).toBe(true)
      expect(text(r)).toBe(cli.said)
      expect(text(r)).toMatch(/Refusing to migrate without a verified backup/)
      expect(session.execCalls().some((c) => c.includes('docker stop'))).toBe(false)
    })
  })
})

describe('clawops_migrate — long-running (R12)', () => {
  it('hands back a taskId when the migration outlasts the sync window, and finishes it in the background', async () => {
    let releaseBackup!: () => void
    const backupDone = new Promise<void>((res) => { releaseBackup = res })
    const session = host(V1_IMAGE).respond(/backup create/, async () => {
      await backupDone
      return { stdout: '{"ok":true}', stderr: '', code: 0 }
    })
    await useHost(session)
    await withTempConfig(async () => {
      const { SYNC_WINDOW } = await import('../../src/mcp/tools/cli/migrate.js')
      const saved = SYNC_WINDOW.ms
      SYNC_WINDOW.ms = 50
      let r: CallToolResult
      try {
        r = await (await handler())({ yes: true }, server().s)
      } finally {
        SYNC_WINDOW.ms = saved
      }

      const body = JSON.parse(text(r)) as { taskId: string; status: string }
      expect(body.status).toBe('running')
      const { getTask } = await import('../../src/mcp/progress.js')
      expect(getTask(body.taskId)?.status).toBe('running')
      expect(session.closed).toBe(false)

      releaseBackup()
      await vi.waitFor(() => expect(getTask(body.taskId)?.status).toBe('completed'))
      expect(getTask(body.taskId)?.result).toMatch(/Migrated to the 2\.0 runtime contract/)
      expect(session.closed).toBe(true)
    })
  })
})
