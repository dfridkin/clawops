import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── dependencies mocked before any import ────────────────────────────────────
vi.mock('../../src/cli/context.js', () => ({ buildContext: vi.fn() }))

const mockGeneratePlan = vi.fn()
vi.mock('../../src/plan/generate.js', () => ({ generatePlan: mockGeneratePlan }))

const mockWriteFileSync = vi.fn()
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, writeFileSync: mockWriteFileSync }
})

import { buildContext } from '../../src/cli/context.js'

const mockBuildContext = vi.mocked(buildContext)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRunFn = (ctx: any) => Promise<void>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cmd: any

const basePlan = {
  apiVersion: 'clawops.dev/v1',
  kind: 'DeployPlan',
  metadata: { name: 'default', generatedAt: new Date().toISOString(), generator: 'clawops', generatorVersion: '0.2.0' },
  spec: {
    provider: 'aws',
    region: 'us-east-1',
    stackName: 'default',
    instanceType: 'small',
    openclaw: { version: 'latest' },
    network: { allowedSshCidrs: [], allowedGatewayCidrs: [] },
  },
  diff: {
    create: [{ urn: 'u1', type: 'aws:ec2/instance:Instance', name: 'server' }],
    update: [],
    delete: [],
    totalChanges: 1,
  },
}

beforeEach(async () => {
  vi.clearAllMocks()
  const mod = await import('../../src/cli/commands/plan.js')
  cmd = mod.default

  mockBuildContext.mockReturnValue({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    config: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    adapter: { name: 'aws' } as any,
    stackName: 'default',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getStack: vi.fn() as any,
  })
  mockGeneratePlan.mockResolvedValue(basePlan)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('plan command', () => {
  it('throws UsageError for local provider', async () => {
    mockBuildContext.mockReturnValue({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      config: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      adapter: { name: 'local' } as any,
      stackName: 'default',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getStack: vi.fn() as any,
    })
    const { UsageError } = await import('../../src/errors/index.js')
    await expect((cmd.run as AnyRunFn)({ args: {} })).rejects.toBeInstanceOf(UsageError)
  })

  it('throws UsageError when --out path is not absolute', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const { UsageError } = await import('../../src/errors/index.js')
    await expect(
      (cmd.run as AnyRunFn)({ args: { out: 'relative/path.json' } }),
    ).rejects.toBeInstanceOf(UsageError)
  })

  it('writes plan to file when --out is absolute', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await (cmd.run as AnyRunFn)({ args: { out: '/tmp/plan.json' } })

    expect(mockWriteFileSync).toHaveBeenCalledOnce()
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      '/tmp/plan.json',
      expect.stringContaining('clawops.dev/v1'),
      'utf-8',
    )
  })

  it('prints plan JSON to stdout when no --out given', async () => {
    const chunks: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk))
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    await (cmd.run as AnyRunFn)({ args: {} })

    const output = chunks.join('')
    const parsed = JSON.parse(output)
    expect(parsed.apiVersion).toBe('clawops.dev/v1')
  })

  it('calls generatePlan with resolved provider and stack args', async () => {
    // buildContext returns gcp adapter for --provider gcp
    mockBuildContext.mockReturnValue({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      config: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      adapter: { name: 'gcp' } as any,
      stackName: 'prod',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getStack: vi.fn() as any,
    })
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    await (cmd.run as AnyRunFn)({
      args: { provider: 'gcp', stack: 'prod', region: 'us-central1', 'instance-type': 'large' },
    })

    expect(mockGeneratePlan).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'gcp',
        region: 'us-central1',
        instanceType: 'large',
      }),
      expect.any(Object),
    )
  })

  it('writes diff summary to stderr (not stdout) to avoid polluting JSON', async () => {
    const stderrChunks: string[] = []
    const stdoutChunks: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(String(chunk))
      return true
    })
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk))
      return true
    })

    await (cmd.run as AnyRunFn)({ args: {} })

    const stderr = stderrChunks.join('')
    const stdout = stdoutChunks.join('')
    expect(stderr).toMatch(/create|update|delete/i)
    // diff info must not appear in the JSON stdout output
    expect(stdout).not.toMatch(/to create/)
  })

  it('propagates errors from generatePlan after spinner failure', async () => {
    mockGeneratePlan.mockRejectedValue(new Error('plan gen error'))
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    await expect((cmd.run as AnyRunFn)({ args: {} })).rejects.toThrow('plan gen error')
  })
})
