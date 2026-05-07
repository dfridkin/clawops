import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// ── dependencies mocked before any import ────────────────────────────────────
const mockApplyPlan = vi.fn()
vi.mock('../../src/plan/apply.js', () => ({ applyPlan: mockApplyPlan }))

// ── readline confirmation mocked globally ─────────────────────────────────────
const mockQuestion = vi.fn()
const mockClose = vi.fn()
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({ question: mockQuestion, close: mockClose })),
}))

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
}

let tmpPlanPath: string

beforeEach(async () => {
  vi.clearAllMocks()
  const mod = await import('../../src/cli/commands/apply.js')
  cmd = mod.default

  // Write a real temp file so readFileSync works (apply.ts reads the file itself)
  const dir = mkdtempSync(path.join(tmpdir(), 'clawops-test-'))
  tmpPlanPath = path.join(dir, 'plan.json')
  writeFileSync(tmpPlanPath, JSON.stringify(basePlan), 'utf-8')

  mockApplyPlan.mockResolvedValue({
    outputs: { gatewayUrl: 'https://gw.example.com', publicIp: '1.2.3.4' },
    changeSummary: { create: 2, same: 1 },
    durationMs: 3000,
  })
  mockQuestion.mockResolvedValue('y')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('apply command', () => {
  it('throws UsageError when no planPath argument is given', async () => {
    const { UsageError } = await import('../../src/errors/index.js')
    await expect((cmd.run as AnyRunFn)({ args: { _: [] } })).rejects.toBeInstanceOf(UsageError)
  })

  it('throws UsageError when planPath is not absolute', async () => {
    const { UsageError } = await import('../../src/errors/index.js')
    await expect(
      (cmd.run as AnyRunFn)({ args: { _: ['relative/path.json'] } }),
    ).rejects.toBeInstanceOf(UsageError)
  })

  it('throws UsageError when plan file does not exist', async () => {
    const { UsageError } = await import('../../src/errors/index.js')
    await expect(
      (cmd.run as AnyRunFn)({ args: { _: ['/nonexistent/plan.json'], yes: true } }),
    ).rejects.toBeInstanceOf(UsageError)
  })

  it('throws UsageError when plan file contains invalid JSON', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'clawops-test-'))
    const badPath = path.join(dir, 'bad.json')
    writeFileSync(badPath, 'not json', 'utf-8')

    const { UsageError } = await import('../../src/errors/index.js')
    await expect(
      (cmd.run as AnyRunFn)({ args: { _: [badPath], yes: true } }),
    ).rejects.toBeInstanceOf(UsageError)
  })

  it('throws UsageError for local provider plan', async () => {
    const localPlan = { ...basePlan, spec: { ...basePlan.spec, provider: 'local' } }
    const dir = mkdtempSync(path.join(tmpdir(), 'clawops-test-'))
    const localPath = path.join(dir, 'local.json')
    writeFileSync(localPath, JSON.stringify(localPlan), 'utf-8')

    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const { UsageError } = await import('../../src/errors/index.js')
    await expect(
      (cmd.run as AnyRunFn)({ args: { _: [localPath], yes: true } }),
    ).rejects.toBeInstanceOf(UsageError)
  })

  it('calls applyPlan with --yes flag skipping readline', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await (cmd.run as AnyRunFn)({ args: { _: [tmpPlanPath], yes: true } })

    expect(mockApplyPlan).toHaveBeenCalledOnce()
    expect(mockQuestion).not.toHaveBeenCalled()
  })

  it('prompts for confirmation without --yes', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await (cmd.run as AnyRunFn)({ args: { _: [tmpPlanPath] } })

    expect(mockQuestion).toHaveBeenCalledOnce()
    expect(mockApplyPlan).toHaveBeenCalledOnce()
  })

  it('exits without calling applyPlan when confirmation is declined', async () => {
    mockQuestion.mockResolvedValue('n')
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit called') })

    await expect(
      (cmd.run as AnyRunFn)({ args: { _: [tmpPlanPath] } }),
    ).rejects.toThrow('process.exit called')
    expect(mockApplyPlan).not.toHaveBeenCalled()
  })

  it('prints gatewayUrl and publicIp after successful apply', async () => {
    const logs: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      logs.push(String(chunk))
      return true
    })
    vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.join(' ')) })

    await (cmd.run as AnyRunFn)({ args: { _: [tmpPlanPath], yes: true } })

    const output = logs.join('\n')
    expect(output).toMatch(/gw\.example\.com|Gateway URL/i)
    expect(output).toMatch(/1\.2\.3\.4|Public IP/i)
  })

  it('propagates errors from applyPlan', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    mockApplyPlan.mockRejectedValue(new Error('infra failure'))
    await expect(
      (cmd.run as AnyRunFn)({ args: { _: [tmpPlanPath], yes: true } }),
    ).rejects.toThrow('infra failure')
  })

  it('--dry-run validates plan and prints diff without applying', async () => {
    const chunks: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((c) => { chunks.push(String(c)); return true })
    vi.spyOn(console, 'log').mockImplementation((...args) => { chunks.push(args.join(' ')) })

    await (cmd.run as AnyRunFn)({ args: { _: [tmpPlanPath], 'dry-run': true } })

    expect(mockApplyPlan).not.toHaveBeenCalled()
    expect(mockQuestion).not.toHaveBeenCalled()
    const output = chunks.join('\n')
    expect(output).toMatch(/[Dd]ry run|valid/)
  })
})
