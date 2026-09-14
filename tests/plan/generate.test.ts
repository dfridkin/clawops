import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock buildContext and its dependencies
vi.mock('../../src/cli/context.js', () => ({
  buildContext: vi.fn(),
}))

vi.mock('../../src/config/store.js', () => ({
  getConfig: vi.fn(() => ({
    defaults: { stack: 'default', provider: 'aws' },
    stacks: { default: { provider: 'aws', region: 'us-east-1', stateUrl: 's3://bucket/clawops' } },
    ssh: { keyPath: '~/.ssh/id_ed25519', knownHostsPath: '~/.clawops/known_hosts' },
    mcp: {},
  })),
  requireConfig: vi.fn(() => ({
    defaults: { stack: 'default', provider: 'aws' },
    stacks: { default: { provider: 'aws', region: 'us-east-1', stateUrl: 's3://bucket/clawops' } },
    ssh: { keyPath: '~/.ssh/id_ed25519', knownHostsPath: '~/.clawops/known_hosts' },
    mcp: {},
  })),
  getConfigDir: vi.fn(() => '/tmp/clawops-test'),
}))

const mockPreview = vi.fn()
const mockSetConfig = vi.fn()
const mockGetStack = vi.fn()

beforeEach(async () => {
  vi.clearAllMocks()

  mockPreview.mockResolvedValue({
    changeSummary: { create: 3, same: 1 },
    stdout: '',
    stderr: '',
  })
  mockSetConfig.mockResolvedValue(undefined)
  mockGetStack.mockResolvedValue({
    preview: mockPreview,
    setConfig: mockSetConfig,
    up: vi.fn(),
  })

  const { buildContext } = await import('../../src/cli/context.js')
  vi.mocked(buildContext).mockReturnValue({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    config: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    adapter: { name: 'aws' } as any,
    stackName: 'default',
    getStack: mockGetStack,
  })
})

describe('generatePlan()', () => {
  it('returns a valid DeployPlan structure', async () => {
    const { generatePlan } = await import('../../src/plan/generate.js')
    const plan = await generatePlan({
      stackName: 'default',
      provider: 'aws',
      region: 'us-east-1',
      instanceType: 'small',
    })

    expect(plan.apiVersion).toBe('clawops.dev/v1')
    expect(plan.kind).toBe('DeployPlan')
    expect(plan.metadata.name).toBe('default')
    expect(plan.metadata.generator).toBe('clawops')
    expect(plan.spec.provider).toBe('aws')
    expect(plan.spec.stackName).toBe('default')
    expect(plan.spec.instanceType).toBe('small')
    expect(plan.spec.region).toBe('us-east-1')
    // Default is a concrete pin from the support matrix, not a moving tag:
    // `latest` and `stable` both now resolve to OpenClaw 2.0, which this line
    // cannot deploy. See docs/spikes/SP-01-container-profile.md.
    expect(plan.spec.openclaw.version).toBe('2026.9.2')
  })

  it('validates the plan against the JSON schema', async () => {
    const { generatePlan } = await import('../../src/plan/generate.js')
    const plan = await generatePlan({
      stackName: 'my-stack',
      provider: 'gcp',
      region: 'us-central1',
    })
    const { validatePlan } = await import('../../src/plan/validate.js')
    const result = validatePlan(plan)
    expect(result.ok).toBe(true)
  })

  it('throws UsageError for local provider', async () => {
    const { generatePlan } = await import('../../src/plan/generate.js')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(generatePlan({ stackName: 'local-stack', provider: 'local' as any }))
      .rejects.toThrow('local provider')
  })

  it('populates diff from changeSummary fallback when line parsing yields nothing', async () => {
    mockPreview.mockResolvedValue({
      changeSummary: { create: 2, update: 1, delete: 0 },
      stdout: '',
    })
    const { generatePlan } = await import('../../src/plan/generate.js')
    const plan = await generatePlan({ stackName: 'default', provider: 'aws' })
    expect(plan.diff?.totalChanges).toBe(3)
  })

  it('parses + lines from preview output into diff.create', async () => {
    mockPreview.mockImplementation(async ({ onOutput }: { onOutput?: (s: string) => void }) => {
      const lines = [
        '+  aws:ec2/instance:Instance  clawops-server  create',
        '+  aws:ec2/eip:Eip            clawops-eip     create',
        '~  aws:iam/role:Role          old-role        update',
      ]
      for (const l of lines) onOutput?.(l)
      return { changeSummary: { create: 2, update: 1 }, stdout: '' }
    })

    const { generatePlan } = await import('../../src/plan/generate.js')
    const plan = await generatePlan({ stackName: 'default', provider: 'aws' })
    expect(plan.diff?.create).toHaveLength(2)
    expect(plan.diff?.create[0]).toMatchObject({ type: 'aws:ec2/instance:Instance' })
    expect(plan.diff?.update).toHaveLength(1)
    expect(plan.diff?.update[0]).toMatchObject({ resource: { type: 'aws:iam/role:Role' } })
    expect(plan.diff?.delete).toHaveLength(0)
    expect(plan.diff?.totalChanges).toBe(3)
  })

  it('applies default instanceType of small', async () => {
    const { generatePlan } = await import('../../src/plan/generate.js')
    const plan = await generatePlan({ stackName: 'default', provider: 'aws' })
    expect(plan.spec.instanceType).toBe('small')
  })

  it('applies a concrete default openclawVersion, not a moving tag', async () => {
    const { generatePlan } = await import('../../src/plan/generate.js')
    const plan = await generatePlan({ stackName: 'default', provider: 'aws' })
    // Default is a concrete pin from the support matrix, not a moving tag:
    // `latest` and `stable` both now resolve to OpenClaw 2.0, which this line
    // cannot deploy. See docs/spikes/SP-01-container-profile.md.
    expect(plan.spec.openclaw.version).toBe('2026.9.2')
  })

  it('returns plan even when preview throws (non-fatal)', async () => {
    mockPreview.mockRejectedValue(new Error('preview failed'))
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const { generatePlan } = await import('../../src/plan/generate.js')
    const plan = await generatePlan({ stackName: 'default', provider: 'aws' })
    expect(plan.apiVersion).toBe('clawops.dev/v1')
    expect(plan.diff).toBeUndefined()
    stderrSpy.mockRestore()
  })

  it('sets Pulumi config values during preview', async () => {
    const { generatePlan } = await import('../../src/plan/generate.js')
    await generatePlan({
      stackName: 'default',
      provider: 'aws',
      region: 'eu-west-1',
      instanceType: 'medium',
      openclawVersion: '2026.9.2',
    })
    expect(mockSetConfig).toHaveBeenCalledWith('instanceType', { value: 'medium' })
    expect(mockSetConfig).toHaveBeenCalledWith('region', { value: 'eu-west-1' })
    expect(mockSetConfig).toHaveBeenCalledWith('openclawVersion', { value: '2026.9.2' })
  })
})

describe('preview parsing', () => {
  it('counts a resource once however often the preview prints it', async () => {
    // Pulumi prints the stack resource in more than one section. Counting each line inflated
    // "7 to create" for a stack that creates four resources — a number an operator approves.
    const lines = [
      '    +   pulumi:pulumi:Stack   clawops-e2e         create',
      '    +   gcp:compute:Network   clawops-network     create',
      '    +   pulumi:pulumi:Stack   clawops-e2e         create',
      '    +   gcp:compute:Network   clawops-network     create',
    ]
    const { parseDiffForTest } = await import('../../src/plan/generate.js')
    const diff = parseDiffForTest(lines)!
    expect(diff.create).toHaveLength(2)
    expect(diff.totalChanges).toBe(2)
  })

  it('keeps two different resources of the same type apart', async () => {
    const { parseDiffForTest } = await import('../../src/plan/generate.js')
    const diff = parseDiffForTest([
      '    +   gcp:compute:Firewall   clawops-firewall-ssh      create',
      '    +   gcp:compute:Firewall   clawops-firewall-gateway  create',
    ])!
    expect(diff.create).toHaveLength(2)
  })

  it('does not merge a create and a delete of the same resource', async () => {
    const { parseDiffForTest } = await import('../../src/plan/generate.js')
    const diff = parseDiffForTest([
      '    +   gcp:compute:Instance   clawops-instance   create',
      '    -   gcp:compute:Instance   clawops-instance   delete',
    ])!
    expect(diff.create).toHaveLength(1)
    expect(diff.delete).toHaveLength(1)
    expect(diff.totalChanges).toBe(2)
  })
})
