// Unit tests for the `stacks` command (list | delete).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { withTempConfig, MINIMAL_CONFIG } from '../helpers/config.js'
import type { ClawopsConfig } from '../../src/config/store.js'

vi.mock('../../src/cli/context.js', () => ({ buildContext: vi.fn() }))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRunFn = (ctx: any) => Promise<void>

async function getCmd() {
  const { default: cmd } = await import('../../src/cli/commands/stacks.js')
  return cmd
}

async function getMocks() {
  const { buildContext } = await import('../../src/cli/context.js')
  return { buildContext: vi.mocked(buildContext) }
}

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

describe('stacks list', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('renders a table with both stacks, marking the default with *', async () => {
    await withTempConfig(TWO_STACK_CONFIG, async () => {
      const writes: string[] = []
      vi.spyOn(process.stdout, 'write').mockImplementation((s) => { writes.push(String(s)); return true })

      const cmd = await getCmd()
      await (cmd.run as AnyRunFn)({ args: { _: ['list'], json: false, yes: false, force: false } })

      const output = writes.join('')
      expect(output).toContain('default *')
      expect(output).toContain('staging')
      expect(output).toContain('gcp')
      expect(output).toContain('aws')
    })
  })

  it('emits JSON with stacks array and default field when --json', async () => {
    await withTempConfig(TWO_STACK_CONFIG, async () => {
      const writes: string[] = []
      vi.spyOn(process.stdout, 'write').mockImplementation((s) => { writes.push(String(s)); return true })

      const cmd = await getCmd()
      await (cmd.run as AnyRunFn)({ args: { _: ['list'], json: true, yes: false, force: false } })

      const output = writes.join('')
      const parsed = JSON.parse(output) as { ok: boolean; data: { stacks: unknown[]; default: string } }
      expect(parsed.ok).toBe(true)
      expect(parsed.data.default).toBe('default')
      expect(parsed.data.stacks).toHaveLength(2)
    })
  })

  it('prints info message when no stacks configured', async () => {
    // withTempConfig always writes MINIMAL_CONFIG which has one stack;
    // override to empty stacks
    const emptyStacks: ClawopsConfig = { ...MINIMAL_CONFIG, stacks: {} as ClawopsConfig['stacks'] }

    await withTempConfig(emptyStacks, async () => {
      const logs: string[] = []
      vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.join(' ')); })

      const cmd = await getCmd()
      await (cmd.run as AnyRunFn)({ args: { _: ['list'], json: false, yes: false, force: false } })

      expect(logs.join(' ')).toMatch(/no stacks/i)
    })
  })
})

describe('stacks delete', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('removes a non-default stack from config when --yes is passed', async () => {
    const { getConfig } = await import('../../src/config/store.js')

    await withTempConfig(TWO_STACK_CONFIG, async () => {
      const cmd = await getCmd()
      await (cmd.run as AnyRunFn)({ args: { _: ['delete', 'staging'], json: false, yes: true, force: false } })

      const updated = getConfig()
      expect(updated?.stacks).not.toHaveProperty('staging')
      expect(updated?.stacks).toHaveProperty('default')
    })
  })

  it('throws UsageError when stack name does not exist', async () => {
    await withTempConfig(TWO_STACK_CONFIG, async () => {
      const cmd = await getCmd()
      await expect(
        (cmd.run as AnyRunFn)({ args: { _: ['delete', 'nonexistent'], json: false, yes: true, force: false } }),
      ).rejects.toThrow('not found in config')
    })
  })

  it('throws UsageError when trying to delete the last remaining stack', async () => {
    // MINIMAL_CONFIG has only one stack
    await withTempConfig(MINIMAL_CONFIG, async () => {
      const cmd = await getCmd()
      await expect(
        (cmd.run as AnyRunFn)({ args: { _: ['delete', 'default'], json: false, yes: true, force: false } }),
      ).rejects.toThrow('only remaining stack')
    })
  })

  it('throws UsageError when deleting the default stack without --force', async () => {
    await withTempConfig(TWO_STACK_CONFIG, async () => {
      const cmd = await getCmd()
      await expect(
        (cmd.run as AnyRunFn)({ args: { _: ['delete', 'default'], json: false, yes: true, force: false } }),
      ).rejects.toThrow('--force')
    })
  })

  it('deletes the default stack with --force and switches default to another stack', async () => {
    const { getConfig } = await import('../../src/config/store.js')

    await withTempConfig(TWO_STACK_CONFIG, async () => {
      const cmd = await getCmd()
      await (cmd.run as AnyRunFn)({ args: { _: ['delete', 'default'], json: false, yes: true, force: true } })

      const updated = getConfig()
      expect(updated?.stacks).not.toHaveProperty('default')
      expect(updated?.stacks).toHaveProperty('staging')
      expect(updated?.defaults.stack).toBe('staging')
    })
  })

  it('exits with code 2 when no action is given', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => {
      throw new Error(`process.exit(${_code})`)
    })

    await withTempConfig(TWO_STACK_CONFIG, async () => {
      const cmd = await getCmd()
      await expect(
        (cmd.run as AnyRunFn)({ args: { _: [], json: false, yes: false, force: false } }),
      ).rejects.toThrow('process.exit(2)')
    })

    exitSpy.mockRestore()
  })

  it('exits with code 2 when delete is called without a name', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => {
      throw new Error(`process.exit(${_code})`)
    })

    await withTempConfig(TWO_STACK_CONFIG, async () => {
      const cmd = await getCmd()
      await expect(
        (cmd.run as AnyRunFn)({ args: { _: ['delete'], json: false, yes: false, force: false } }),
      ).rejects.toThrow('process.exit(2)')
    })

    exitSpy.mockRestore()
  })

  it('blocks delete of a deployed cloud stack without --force', async () => {
    const { buildContext } = await getMocks()
    buildContext.mockReturnValue({
      adapter: {
        name: 'aws',
        getConnectionInfo: vi.fn(),
      },
      getStack: vi.fn().mockResolvedValue({
        outputs: vi.fn().mockResolvedValue({ publicIp: { value: '1.2.3.4' } }),
      }),
    } as unknown as ReturnType<typeof buildContext>)

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => {
      throw new Error(`process.exit(${_code})`)
    })

    await withTempConfig(TWO_STACK_CONFIG, async () => {
      const cmd = await getCmd()
      await expect(
        (cmd.run as AnyRunFn)({ args: { _: ['delete', 'staging'], json: false, yes: true, force: false } }),
      ).rejects.toThrow('process.exit(1)')
      expect(exitSpy).toHaveBeenCalledWith(1)
    })

    exitSpy.mockRestore()
  })

  it('allows delete of a deployed stack with --force', async () => {
    const { getConfig } = await import('../../src/config/store.js')

    await withTempConfig(TWO_STACK_CONFIG, async () => {
      const cmd = await getCmd()
      await (cmd.run as AnyRunFn)({ args: { _: ['delete', 'staging'], json: false, yes: true, force: true } })
      const updated = getConfig()
      expect(updated?.stacks).not.toHaveProperty('staging')
      expect(updated?.stacks).toHaveProperty('default')
    })
  })
})
