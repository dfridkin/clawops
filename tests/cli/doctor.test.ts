import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The checks themselves are tested in tests/diagnostics/doctor.test.ts against the report
// they return. What is left here is the command: rendering, --json, and the exit code.
const { mockRunDiagnostics } = vi.hoisted(() => ({ mockRunDiagnostics: vi.fn() }))
vi.mock('../../src/diagnostics/index.js', () => ({ runDiagnostics: mockRunDiagnostics }))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRunFn = (ctx: any) => Promise<void>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cmd: any

const HEALTHY = {
  sections: [
    { title: 'Runtime', checks: [{ name: 'Node.js', status: 'pass', detail: 'v22.0.0' }] },
    { title: 'SSH', checks: [{ name: 'known_hosts', status: 'warn', detail: 'does not exist' }] },
  ],
  ok: true,
  counts: { pass: 1, fail: 0, warn: 1, info: 0 },
}
const BROKEN = {
  sections: [
    {
      title: 'SSH',
      checks: [
        { name: 'SSH key', status: 'fail', detail: '/k (not readable)', remedy: 'check the path' },
      ],
    },
  ],
  ok: false,
  counts: { pass: 0, fail: 1, warn: 0, info: 0 },
}

let writes: string[]
let errors: string[]

beforeEach(async () => {
  vi.clearAllMocks()
  writes = []
  errors = []
  mockRunDiagnostics.mockResolvedValue(HEALTHY)
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { writes.push(String(s)); return true })
  vi.spyOn(console, 'log').mockImplementation((...a) => { writes.push(a.join(' ')) })
  vi.spyOn(console, 'warn').mockImplementation((...a) => { writes.push(a.join(' ')) })
  vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a.join(' ')) })
  cmd = (await import('../../src/cli/commands/doctor.js')).default
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('doctor command', () => {
  it('renders every section and check', async () => {
    await (cmd.run as AnyRunFn)({ args: {} })
    const out = writes.join('\n')
    expect(out).toContain('Runtime')
    expect(out).toContain('Node.js')
    expect(out).toContain('v22.0.0')
    expect(out).toContain('known_hosts')
  })

  it('prints a remedy when a check has one', async () => {
    mockRunDiagnostics.mockResolvedValue(BROKEN)
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit') })
    await expect((cmd.run as AnyRunFn)({ args: {} })).rejects.toThrow('exit')
    expect([...writes, ...errors].join('\n')).toContain('check the path')
  })

  it('passes the stack through', async () => {
    await (cmd.run as AnyRunFn)({ args: { stack: 'prod' } })
    expect(mockRunDiagnostics).toHaveBeenCalledWith(
      expect.objectContaining({ stack: 'prod' }),
    )
  })

  it('exits 0 on a report with warnings but no failures', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit') })
    await (cmd.run as AnyRunFn)({ args: {} })
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('exits 1 on any failed check, not only an old Node.js', async () => {
    // The old command exited 1 solely on the Node version. An unreadable SSH key or an
    // unsupported gateway exited 0, so a CI step running `clawops doctor` read a broken
    // deployment as success.
    mockRunDiagnostics.mockResolvedValue(BROKEN)
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit') })
    await expect((cmd.run as AnyRunFn)({ args: {} })).rejects.toThrow('exit')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('emits the report as JSON under --json, and nothing else', async () => {
    await (cmd.run as AnyRunFn)({ args: { json: true } })
    const parsed = JSON.parse(writes.join(''))
    expect(parsed.ok).toBe(true)
    expect(parsed.data.sections).toHaveLength(2)
  })

  it('keeps --json parseable when the report failed', async () => {
    // The human path prints a "run clawops bug" line after the report. Under --json that
    // would land after the closing brace and break every consumer.
    mockRunDiagnostics.mockResolvedValue(BROKEN)
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit') })
    await expect((cmd.run as AnyRunFn)({ args: { json: true } })).rejects.toThrow('exit')
    expect(() => JSON.parse(writes.join(''))).not.toThrow()
  })

  it('removes its signal handlers when it finishes', async () => {
    const before = process.listenerCount('SIGINT')
    await (cmd.run as AnyRunFn)({ args: {} })
    expect(process.listenerCount('SIGINT')).toBe(before)
  })
})
