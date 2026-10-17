// Unit tests for the `status` command.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeContext, makeLocalFakeContext, FAKE_LOCAL_STATE } from '../helpers/context.js'

vi.mock('../../src/cli/context.js', () => ({ buildContext: vi.fn() }))

// Requests from the stack's host agent are read over SSH. Faked here so no test dials a host;
// the read itself is tested in tests/hostagent/operator.test.ts.
const h = vi.hoisted(() => ({ pendingOnHost: vi.fn() }))
vi.mock('../../src/hostagent/operator.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/hostagent/operator.js')>()),
  pendingOnHost: h.pendingOnHost,
}))
beforeEach(() => {
  h.pendingOnHost.mockReset()
  h.pendingOnHost.mockResolvedValue({ ok: true, value: [] })
})

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

describe('status command — requests from the host agent (ADR 0014 §3)', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  async function run(json: boolean) {
    const { buildContext } = await getMocks()
    buildContext.mockReturnValue(makeFakeContext())
    const out: string[] = []
    const err: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out.push(String(s)); return true })
    vi.spyOn(process.stderr, 'write').mockImplementation((s) => { err.push(String(s)); return true })
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')) })
    const cmd = await getCmd()
    await (cmd.run as AnyRunFn)({ args: { stack: undefined, json } })
    vi.restoreAllMocks()
    return { out: out.join(''), err: err.join('') }
  }

  const request = {
    id: '1', at: '2026-10-17T10:00:00.000Z', tool: 'clawops_gateway_restart', stack: 'default',
    command: 'clawops gateway restart --stack default', needsValue: false,
  }

  it('prints the banner after the table', async () => {
    h.pendingOnHost.mockResolvedValue({ ok: true, value: [request] })
    const { out } = await run(false)
    expect(out).toContain('default has 1 request from its agent:\n    clawops gateway restart --stack default')
    expect(out.indexOf('1.2.3.4')).toBeLessThan(out.indexOf('request from its agent'))
  })

  it('prints nothing extra when there are none', async () => {
    const { out } = await run(false)
    expect(out).not.toContain('from its agent')
  })

  it('says so when the host could not be asked, rather than showing none', async () => {
    h.pendingOnHost.mockResolvedValue({ ok: false, error: 'connect ETIMEDOUT' })
    const { out, err } = await run(false)
    expect(out + err).toContain('Could not check the host for requests from its agent: connect ETIMEDOUT')
  })

  it('reports them in --json', async () => {
    h.pendingOnHost.mockResolvedValue({ ok: true, value: [request] })
    const parsed = JSON.parse((await run(true)).out)
    expect(parsed.data.pendingHandoffs).toEqual([{ at: request.at, command: request.command }])
  })

  it('does not ask a stack that is not deployed', async () => {
    const ctx = makeFakeContext()
    ctx.getStack = vi.fn().mockResolvedValue({ outputs: vi.fn().mockResolvedValue({}) })
    const { buildContext } = await getMocks()
    buildContext.mockReturnValue(ctx)
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const cmd = await getCmd()
    await (cmd.run as AnyRunFn)({ args: { stack: undefined, json: false } })
    vi.restoreAllMocks()
    expect(h.pendingOnHost).not.toHaveBeenCalled()
  })
})
