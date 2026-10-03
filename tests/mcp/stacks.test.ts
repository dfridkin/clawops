// clawops_stacks_delete — forgetting a stack, from an agent.
//
// The tool and `clawops stacks delete` share their checks (src/config/stack-delete.ts). These
// tests hold the tool to the CLI's refusals by running the CLI on the same config and comparing
// words, rather than by restating the messages here — a restated message would agree with
// itself after either surface drifted.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { withTempConfig, MINIMAL_CONFIG } from '../helpers/config.js'
import type { ClawopsConfig } from '../../src/config/store.js'

vi.mock('../../src/cli/context.js', () => ({ buildContext: vi.fn() }))

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- citty's run() takes a loosely typed context
type AnyRunFn = (ctx: any) => Promise<void>

const TWO_STACK_CONFIG: ClawopsConfig = {
  ...MINIMAL_CONFIG,
  defaults: { stack: 'default', provider: 'gcp' },
  stacks: {
    default: {
      provider: 'gcp',
      stateUrl: 'gs://test-bucket/clawops',
      region: 'us-central1',
      credentialsRef: { source: 'env', envVars: ['GOOGLE_APPLICATION_CREDENTIALS'] },
    },
    staging: {
      provider: 'aws',
      stateUrl: 's3://my-bucket/clawops',
      region: 'us-east-1',
      credentialsRef: { source: 'env', envVars: ['AWS_PROFILE'] },
    },
  },
}

function server(opts: { elicitation?: boolean; action?: 'accept' | 'decline'; confirmed?: boolean } = {}) {
  const elicitInput = vi.fn().mockResolvedValue({
    action: opts.action ?? 'accept',
    content: { confirmed: opts.confirmed ?? true },
  })
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

async function handler() {
  const { handleStacksDelete } = await import('../../src/mcp/tools/cli/stacks.js')
  return handleStacksDelete
}

async function stacksInConfig(): Promise<string[]> {
  const { getConfig } = await import('../../src/config/store.js')
  return Object.keys(getConfig()?.stacks ?? {})
}

/** A cloud stack whose Pulumi outputs say it is deployed. */
async function deployed() {
  const { buildContext } = await import('../../src/cli/context.js')
  vi.mocked(buildContext).mockReturnValue({
    adapter: { name: 'aws' },
    getStack: vi.fn().mockResolvedValue({
      outputs: vi.fn().mockResolvedValue({ publicIp: { value: '1.2.3.4' } }),
    }),
  } as unknown as ReturnType<typeof buildContext>)
  return vi.mocked(buildContext)
}

/** A cloud stack with no outputs — torn down, safe to forget. */
async function notDeployed() {
  const { buildContext } = await import('../../src/cli/context.js')
  vi.mocked(buildContext).mockReturnValue({
    adapter: { name: 'aws' },
    getStack: vi.fn().mockResolvedValue({ outputs: vi.fn().mockResolvedValue({}) }),
  } as unknown as ReturnType<typeof buildContext>)
  return vi.mocked(buildContext)
}

/** What the CLI says when it refuses `stacks delete <name>` with these flags. */
async function cliRefusal(name: string, force = false): Promise<string> {
  const { default: cmd } = await import('../../src/cli/commands/stacks.js')
  const errors: string[] = []
  const spies = [
    vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a.join(' ')) }),
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`)
    }) as never),
  ]
  try {
    await (cmd.run as AnyRunFn)({ args: { _: ['delete', name], yes: true, force } })
  } catch (err) {
    const msg = (err as Error).message
    if (!msg.startsWith('process.exit')) return msg
    // `failure()` prefixes a coloured cross; the words follow it.
    return errors.join('\n').replace(/^.*?✗\s+/, '')
  } finally {
    for (const spy of spies) spy.mockRestore()
  }
  throw new Error('the CLI did not refuse')
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('clawops_stacks_delete — confirmation (R19)', () => {
  it('asks before forgetting, and says it does not tear anything down', async () => {
    await notDeployed()
    await withTempConfig(TWO_STACK_CONFIG, async () => {
      const { s, elicitInput } = server()
      const r = await (await handler())({ name: 'staging', force: false, yes: false }, s)
      expect(r.isError).toBeFalsy()
      expect(elicitInput).toHaveBeenCalledOnce()
      const message = (elicitInput.mock.calls[0]![0] as { message: string }).message
      expect(message).toMatch(/staging/)
      expect(message).toMatch(/does NOT tear down/)
      expect(await stacksInConfig()).toEqual(['default'])
    })
  })

  it('changes nothing when the user declines', async () => {
    await notDeployed()
    await withTempConfig(TWO_STACK_CONFIG, async () => {
      const { s } = server({ action: 'decline' })
      const r = await (await handler())({ name: 'staging', force: false, yes: false }, s)
      expect(text(r)).toMatch(/Nothing was changed/)
      expect(await stacksInConfig()).toEqual(['default', 'staging'])
    })
  })

  it('tells a client that cannot be asked to call again with yes: true, and changes nothing', async () => {
    await notDeployed()
    await withTempConfig(TWO_STACK_CONFIG, async () => {
      const { s, elicitInput } = server({ elicitation: false })
      const r = await (await handler())({ name: 'staging', force: false, yes: false }, s)
      expect(text(r)).toMatch(/call this tool again with\s+`yes: true`/)
      expect(elicitInput).not.toHaveBeenCalled()
      expect(await stacksInConfig()).toEqual(['default', 'staging'])
    })
  })

  it('does not ask when yes: true, and forgets the stack', async () => {
    await notDeployed()
    await withTempConfig(TWO_STACK_CONFIG, async () => {
      const { s, elicitInput } = server({ elicitation: false })
      const r = await (await handler())({ name: 'staging', force: false, yes: true }, s)
      expect(r.isError).toBeFalsy()
      expect(text(r)).toMatch(/Stack "staging" removed from config\./)
      expect(text(r)).toMatch(/Cloud resources are NOT destroyed/)
      expect(elicitInput).not.toHaveBeenCalled()
      expect(await stacksInConfig()).toEqual(['default'])
    })
  })

  it('with force, warns that a deployed stack keeps running and billing', async () => {
    await withTempConfig(TWO_STACK_CONFIG, async () => {
      const { s, elicitInput } = server()
      await (await handler())({ name: 'staging', force: true, yes: false }, s)
      const message = (elicitInput.mock.calls[0]![0] as { message: string }).message
      expect(message).toMatch(/running and billing/)
    })
  })
})

describe('clawops_stacks_delete — refusals are the CLI\'s, word for word', () => {
  it('refuses a stack that is not in config', async () => {
    await withTempConfig(TWO_STACK_CONFIG, async () => {
      const cli = await cliRefusal('nope')
      const { s, elicitInput } = server()
      const r = await (await handler())({ name: 'nope', force: false, yes: true }, s)
      expect(r.isError).toBe(true)
      expect(text(r)).toBe(cli)
      expect(cli).toMatch(/not found in config/)
      expect(elicitInput).not.toHaveBeenCalled()
    })
  })

  it('refuses the only remaining stack, even with force', async () => {
    await withTempConfig(MINIMAL_CONFIG, async () => {
      const cli = await cliRefusal('default', true)
      const { s } = server()
      const r = await (await handler())({ name: 'default', force: true, yes: true }, s)
      expect(r.isError).toBe(true)
      expect(text(r)).toBe(cli)
      expect(cli).toMatch(/only remaining stack/)
      expect(await stacksInConfig()).toEqual(['default'])
    })
  })

  it('refuses the default stack without force', async () => {
    await notDeployed()
    await withTempConfig(TWO_STACK_CONFIG, async () => {
      const cli = await cliRefusal('default')
      const { s } = server()
      const r = await (await handler())({ name: 'default', force: false, yes: true }, s)
      expect(r.isError).toBe(true)
      expect(text(r)).toBe(cli)
      expect(cli).toMatch(/is the default stack/)
      expect(await stacksInConfig()).toEqual(['default', 'staging'])
    })
  })

  it('refuses a stack that is still deployed, before asking', async () => {
    await deployed()
    await withTempConfig(TWO_STACK_CONFIG, async () => {
      const cli = await cliRefusal('staging')
      const { s, elicitInput } = server()
      const r = await (await handler())({ name: 'staging', force: false, yes: false }, s)
      expect(r.isError).toBe(true)
      expect(text(r)).toBe(cli)
      expect(cli).toMatch(/is still deployed/)
      expect(elicitInput).not.toHaveBeenCalled()
      expect(await stacksInConfig()).toEqual(['default', 'staging'])
    })
  })
})

describe('clawops_stacks_delete — force is --force', () => {
  it('forgets a deployed stack without checking its deployment', async () => {
    const buildContext = await deployed()
    await withTempConfig(TWO_STACK_CONFIG, async () => {
      const { s } = server()
      const r = await (await handler())({ name: 'staging', force: true, yes: true }, s)
      expect(r.isError).toBeFalsy()
      expect(buildContext).not.toHaveBeenCalled()
      expect(await stacksInConfig()).toEqual(['default'])
    })
  })

  it('forgets the default stack and switches the default', async () => {
    await withTempConfig(TWO_STACK_CONFIG, async () => {
      const { s } = server()
      const r = await (await handler())({ name: 'default', force: true, yes: true }, s)
      expect(r.isError).toBeFalsy()
      expect(text(r)).toMatch(/Default stack switched to "staging"/)
      const { getConfig } = await import('../../src/config/store.js')
      expect(getConfig()?.defaults.stack).toBe('staging')
      expect(await stacksInConfig()).toEqual(['staging'])
    })
  })
})
