// Unit tests for the `status` command.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeContext, makeLocalFakeContext, FAKE_LOCAL_STATE } from '../helpers/context.js'

vi.mock('../../src/cli/context.js', () => ({ buildContext: vi.fn() }))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRunFn = (ctx: any) => Promise<void>

async function getCmd() {
  const { default: cmd } = await import('../../src/cli/commands/status.js')
  return cmd
}

async function getMocks() {
  const { buildContext } = await import('../../src/cli/context.js')
  return { buildContext: vi.mocked(buildContext) }
}

describe('status command — local provider', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('renders table with connection fields when state is present', async () => {
    const { buildContext } = await getMocks()
    buildContext.mockReturnValue(makeLocalFakeContext(FAKE_LOCAL_STATE))

    const writes: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => { writes.push(String(s)); return true })

    const cmd = await getCmd()
    await (cmd.run as AnyRunFn)({ args: { stack: undefined, json: false } })

    vi.restoreAllMocks()
    const output = writes.join('')
    expect(output).toMatch(/10\.0\.0\.1/)
    expect(output).toMatch(/local-default/)
  })

  it('shows "not bootstrapped" when localState is null', async () => {
    const { buildContext } = await getMocks()
    buildContext.mockReturnValue(makeLocalFakeContext(null))

    const writes: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => { writes.push(String(s)); return true })

    const cmd = await getCmd()
    await (cmd.run as AnyRunFn)({ args: { stack: undefined, json: false } })

    vi.restoreAllMocks()
    const output = writes.join('')
    expect(output).toMatch(/not bootstrapped/)
  })

  it('emits JSON with stack + state fields when --json', async () => {
    const { buildContext } = await getMocks()
    buildContext.mockReturnValue(makeLocalFakeContext(FAKE_LOCAL_STATE))

    const writes: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => { writes.push(String(s)); return true })

    const cmd = await getCmd()
    await (cmd.run as AnyRunFn)({ args: { stack: undefined, json: true } })

    vi.restoreAllMocks()
    const raw = writes.join('')
    const parsed = JSON.parse(raw)
    expect(parsed.ok).toBe(true)
    expect(parsed.data.stack).toBe('local-default')
    expect(parsed.data.sshHost).toBe('10.0.0.1')
  })

  it('emits JSON with not-bootstrapped status when --json and no state', async () => {
    const { buildContext } = await getMocks()
    buildContext.mockReturnValue(makeLocalFakeContext(null))

    const writes: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => { writes.push(String(s)); return true })

    const cmd = await getCmd()
    await (cmd.run as AnyRunFn)({ args: { stack: undefined, json: true } })

    vi.restoreAllMocks()
    const parsed = JSON.parse(writes.join(''))
    expect(parsed.data.status).toMatch(/not bootstrapped/)
  })
})

describe('status command — cloud provider', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('renders table with stack outputs when deployed', async () => {
    const { buildContext } = await getMocks()
    buildContext.mockReturnValue(makeFakeContext())

    const writes: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => { writes.push(String(s)); return true })

    const cmd = await getCmd()
    await (cmd.run as AnyRunFn)({ args: { stack: undefined, json: false } })

    vi.restoreAllMocks()
    const output = writes.join('')
    expect(output).toMatch(/1\.2\.3\.4/)    // publicIp
    expect(output).toMatch(/us-central1/)   // region
  })

  it('shows "not deployed" when stack outputs are empty', async () => {
    const ctx = makeFakeContext()
    // Override getStack to return empty outputs
    ctx.getStack = vi.fn().mockResolvedValue({
      outputs: vi.fn().mockResolvedValue({}),
    })
    const { buildContext } = await getMocks()
    buildContext.mockReturnValue(ctx)

    const writes: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => { writes.push(String(s)); return true })

    const cmd = await getCmd()
    await (cmd.run as AnyRunFn)({ args: { stack: undefined, json: false } })

    vi.restoreAllMocks()
    expect(writes.join('')).toMatch(/not deployed/)
  })

  it('emits JSON with stack outputs when --json', async () => {
    const { buildContext } = await getMocks()
    buildContext.mockReturnValue(makeFakeContext())

    const writes: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => { writes.push(String(s)); return true })

    const cmd = await getCmd()
    await (cmd.run as AnyRunFn)({ args: { stack: undefined, json: true } })

    vi.restoreAllMocks()
    const parsed = JSON.parse(writes.join(''))
    expect(parsed.ok).toBe(true)
    expect(parsed.data.stack).toBe('default')
    expect(parsed.data.publicIp).toBe('1.2.3.4')
  })
})
