// The day-2 commands on a local-provider stack.
//
// `gateway`, `agents`, `config` and `logs` each built their connection by reading a Pulumi
// stack, which the local provider does not have — so every one of them failed on a local stack
// with "The local provider does not use Pulumi stacks", while the MCP tools for the same
// operations worked. The provider matrix marked all four supported. The MCP e2e found it by
// trying to drive the CLI against the same host.
//
// Each case asks only one thing: does the command connect to the address in the local state,
// without asking for a Pulumi stack. What it then does is covered by each command's own tests.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeLocalFakeContext, FAKE_LOCAL_STATE } from '../helpers/context.js'
import { FakeSshSession } from '../helpers/ssh.js'

vi.mock('../../src/cli/context.js', () => ({ buildContext: vi.fn() }))
vi.mock('../../src/transport/pool.js', () => ({ acquireSession: vi.fn(), drainPool: vi.fn() }))
vi.mock('../../src/transport/ssh.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/transport/ssh.js')>()),
  connect: vi.fn(),
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- citty's run() takes a loosely typed context
type AnyRunFn = (ctx: any) => Promise<void>

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
})

async function wire() {
  const ctx = makeLocalFakeContext()
  const getStack = vi.fn().mockRejectedValue(new Error('The local provider does not use Pulumi stacks.'))
  Object.assign(ctx, { getStack })
  const { buildContext } = await import('../../src/cli/context.js')
  vi.mocked(buildContext).mockReturnValue(ctx)

  const session = new FakeSshSession().respond(/.*/, { stdout: '{}' })
  const { acquireSession } = await import('../../src/transport/pool.js')
  vi.mocked(acquireSession).mockResolvedValue({ session, release: vi.fn() } as never)
  const { connect } = await import('../../src/transport/ssh.js')
  vi.mocked(connect).mockResolvedValue(session as never)
  return { getStack, acquireSession: vi.mocked(acquireSession), connect: vi.mocked(connect) }
}

const CASES: Array<[string, () => Promise<{ default: unknown }>, Record<string, unknown>]> = [
  ['gateway status', () => import('../../src/cli/commands/gateway.js'), { _: ['status'], json: true }],
  ['agents list', () => import('../../src/cli/commands/agents.js'), { _: ['list'], json: true }],
  ['config get', () => import('../../src/cli/commands/config.js'), { _: ['get'], json: true }],
  ['logs', () => import('../../src/cli/commands/logs.js'), { tail: '5' }],
]

describe('day-2 commands connect to a local stack from its local state', () => {
  for (const [name, load, args] of CASES) {
    it(`clawops ${name}`, async () => {
      const m = await wire()
      const { default: cmd } = (await load()) as { default: { run: AnyRunFn } }
      await cmd.run({ args: { stack: undefined, ...args } }).catch(() => undefined)

      expect(m.getStack).not.toHaveBeenCalled()
      const used = [...m.acquireSession.mock.calls, ...m.connect.mock.calls].map((c) => c[0] as { host: string; port: number })
      expect(used.length).toBeGreaterThan(0)
      expect(used[0]).toMatchObject({ host: FAKE_LOCAL_STATE.sshHost, port: FAKE_LOCAL_STATE.sshPort })
    })
  }
})
