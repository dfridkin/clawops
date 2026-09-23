// clawops_init: the call that makes every other call possible.
//
// Without a config every tool refuses, so on a machine that has never run clawops — a fresh
// container, a directory's sandbox — the refusal was the whole server. It could only be fixed
// from a terminal, which an agent does not have.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const { mockInitStack } = vi.hoisted(() => ({ mockInitStack: vi.fn() }))
vi.mock('../../src/config/init.js', () => ({ initStack: mockInitStack }))

const noopServer = {} as unknown as McpServer
const text = (r: { content?: unknown[] }) => String((r.content?.[0] as { text?: unknown })?.text ?? '')

const OK = {
  ok: true as const,
  configPath: '/home/u/.clawops/config.json',
  stackName: 'sandbox',
  provider: 'aws' as const,
  stateUrl: 's3://bucket/clawops',
  region: 'us-east-1',
  keyPath: '/home/u/.clawops/id_ed25519',
  keyGenerated: true,
}

beforeEach(() => {
  vi.clearAllMocks()
  mockInitStack.mockResolvedValue(OK)
})

describe('clawops_init', () => {
  it('registers the stack and reports where everything went', async () => {
    const { handleInit } = await import('../../src/mcp/tools/cli/init.js')
    const r = await handleInit({ provider: 'aws', stateUrl: 's3://bucket/clawops', stackName: 'sandbox' }, noopServer)
    expect(mockInitStack).toHaveBeenCalledWith(expect.objectContaining({ provider: 'aws', stackName: 'sandbox' }))
    expect(text(r)).toContain('s3://bucket/clawops')
    expect(text(r)).toContain('/home/u/.clawops/config.json')
  })

  /*
   * An evaluator runs this in a sandbox with no cloud account. Saying plainly that nothing was
   * provisioned is the difference between trying the next tool and closing the tab.
   */
  it('says that nothing was provisioned and nothing is charged', async () => {
    const { handleInit } = await import('../../src/mcp/tools/cli/init.js')
    const r = await handleInit({ provider: 'aws', stateUrl: 's3://b/c' }, noopServer)
    expect(text(r)).toMatch(/[Nn]othing has been provisioned/)
    expect(text(r)).toMatch(/nothing is being charged/)
  })

  it('distinguishes a generated key from one that already existed', async () => {
    const { handleInit } = await import('../../src/mcp/tools/cli/init.js')
    expect(text(await handleInit({ provider: 'aws' }, noopServer))).toContain('generated now')
    mockInitStack.mockResolvedValue({ ...OK, keyGenerated: false })
    expect(text(await handleInit({ provider: 'aws' }, noopServer))).toContain('already existed')
  })

  it('relays a refusal as an error, not as success', async () => {
    mockInitStack.mockResolvedValue({ ok: false, reason: 'Stack "prod" already exists' })
    const { handleInit } = await import('../../src/mcp/tools/cli/init.js')
    const r = await handleInit({ provider: 'aws', stackName: 'prod' }, noopServer)
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('already exists')
  })

  it('passes the local provider its host, which cloud stacks do not have', async () => {
    const { handleInit } = await import('../../src/mcp/tools/cli/init.js')
    await handleInit({ provider: 'local', host: '10.0.0.5', sshUser: 'ubuntu', sshPort: 2222 }, noopServer)
    expect(mockInitStack).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'local', host: '10.0.0.5', sshUser: 'ubuntu', sshPort: 2222 }),
    )
  })
})
