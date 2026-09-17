import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGetProvider } = vi.hoisted(() => ({ mockGetProvider: vi.fn() }))
vi.mock('../../src/providers/index.js', () => ({ getProvider: mockGetProvider }))

const { mockSuccess, mockWarn, mockInfo, mockFailure } = vi.hoisted(() => ({
  mockSuccess: vi.fn(), mockWarn: vi.fn(), mockInfo: vi.fn(), mockFailure: vi.fn(),
}))
vi.mock('../../src/output/human.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/output/human.js')>()),
  success: mockSuccess, warn: mockWarn, info: mockInfo, failure: mockFailure,
}))

import { runAccountPreflight, stateBucketQuestion } from '../../src/cli/commands/setup.js'
import type { PreflightCheck } from '../../src/providers/types.js'

/** An inquirer stand-in that answers every confirm the same way and records what it was asked. */
function fakeInquirer(answer: boolean) {
  const asked: string[] = []
  return {
    inquirer: {
      prompt: vi.fn(async (qs: { message: string }[]) => {
        asked.push(...qs.map((q) => q.message))
        return { apply: answer }
      }),
    } as never,
    asked,
  }
}

function withChecks(checks: PreflightCheck[]) {
  const preflight = vi.fn(async () => checks)
  mockGetProvider.mockReturnValue({ name: 'azure', preflight })
  return preflight
}

const said = (m: ReturnType<typeof vi.fn>) => m.mock.calls.map((c) => String(c[0])).join('\n')

beforeEach(() => vi.clearAllMocks())

describe('the wizard asks about the size the operator actually chose', () => {
  it('passes the chosen size to the provider, not the provider default', async () => {
    const preflight = withChecks([])
    await runAccountPreflight({
      provider: 'azure',
      region: 'eastus',
      bucket: 'state',
      instanceType: 'Standard_D4as_v7',
      ...fakeInquirer(true),
    })
    expect(preflight).toHaveBeenCalledWith(
      expect.objectContaining({ instanceType: 'Standard_D4as_v7' }),
    )
  })

  it('passes undefined when no size was chosen, so the provider picks its default', async () => {
    const preflight = withChecks([])
    await runAccountPreflight({ provider: 'azure', ...fakeInquirer(true) })
    expect(preflight).toHaveBeenCalledWith(expect.objectContaining({ instanceType: undefined }))
  })
})

describe('a check clawops could not put is neither a pass nor a failure', () => {
  const unanswered: PreflightCheck = {
    id: 'size-available',
    label: 'Standard_D2s_v5 is available in eastus',
    ok: false,
    unknown: true,
    detail: 'clawops could not list SKUs: AuthorizationFailed.',
  }

  it('still reports the account as ready, qualified', async () => {
    withChecks([{ id: 'sub', label: 'subscription is set', ok: true }, unanswered])
    await runAccountPreflight({ provider: 'azure', ...fakeInquirer(true) })
    expect(said(mockSuccess)).toContain('as far as clawops could tell')
  })

  it('does not qualify the verdict when every check was answered', async () => {
    withChecks([{ id: 'sub', label: 'subscription is set', ok: true }])
    await runAccountPreflight({ provider: 'azure', ...fakeInquirer(true) })
    expect(said(mockSuccess)).toBe('azure account is ready.')
  })

  it('names the check and why it could not be answered', async () => {
    withChecks([unanswered])
    await runAccountPreflight({ provider: 'azure', ...fakeInquirer(true) })
    expect(said(mockWarn)).toContain('Could not check: Standard_D2s_v5 is available in eastus')
    expect(said(mockInfo)).toContain('AuthorizationFailed')
  })

  it('never offers to fix what it could not check', async () => {
    const { inquirer, asked } = fakeInquirer(true)
    withChecks([{ ...unanswered, fix: vi.fn(), mutates: 'Creates something' }])
    await runAccountPreflight({ provider: 'azure', inquirer })
    expect(asked).toEqual([])
  })
})

describe('a real failure still stops the account being called ready', () => {
  const broken: PreflightCheck = {
    id: 'bucket',
    label: 'State bucket exists',
    ok: false,
    detail: 'Not found.',
    mutates: 'Creates bucket "state"',
  }

  it('says nothing about readiness, and offers the fix', async () => {
    const fix = vi.fn()
    const { inquirer, asked } = fakeInquirer(true)
    withChecks([{ ...broken, fix }])
    await runAccountPreflight({ provider: 'azure', inquirer })
    expect(mockSuccess).not.toHaveBeenCalledWith(expect.stringContaining('ready'))
    expect(asked).toEqual(['Fix this now? Creates bucket "state"'])
    expect(fix).toHaveBeenCalledOnce()
  })

  it('leaves it alone when the operator declines', async () => {
    const fix = vi.fn()
    withChecks([{ ...broken, fix }])
    await runAccountPreflight({ provider: 'azure', ...fakeInquirer(false) })
    expect(fix).not.toHaveBeenCalled()
    expect(said(mockInfo)).toContain('Left as is')
  })

  it('reports a fix that throws rather than claiming it worked', async () => {
    withChecks([{ ...broken, fix: vi.fn(async () => { throw new Error('quota exceeded') }) }])
    await runAccountPreflight({ provider: 'azure', ...fakeInquirer(true) })
    expect(said(mockFailure)).toContain('quota exceeded')
    expect(said(mockSuccess)).not.toContain('Done')
  })

  it('an unanswered check alongside a real failure does not soften the failure', async () => {
    const { inquirer, asked } = fakeInquirer(true)
    withChecks([{ id: 'size', label: 'size', ok: false, unknown: true }, { ...broken, fix: vi.fn() }])
    await runAccountPreflight({ provider: 'azure', inquirer })
    expect(said(mockSuccess)).not.toContain('account is ready')
    expect(asked).toEqual(['Fix this now? Creates bucket "state"'])
  })
})

describe('a provider that cannot be asked at all', () => {
  it('warns instead of throwing out of the wizard', async () => {
    mockGetProvider.mockImplementation(() => { throw new Error('no adapter registered') })
    await expect(
      runAccountPreflight({ provider: 'aws', ...fakeInquirer(true) }),
    ).resolves.toBeUndefined()
    expect(said(mockWarn)).toContain('no adapter registered')
  })

  it('says nothing when the adapter has no preflight to run', async () => {
    mockGetProvider.mockReturnValue({ name: 'local' })
    await runAccountPreflight({ provider: 'aws', ...fakeInquirer(true) })
    expect(mockSuccess).not.toHaveBeenCalled()
    expect(mockWarn).not.toHaveBeenCalled()
  })
})

describe('the state-backend question arrives already answered', () => {
  it('fills in the name clawops would choose, scoped to the account and region', () => {
    const q = stateBucketQuestion('aws', '614126170912')
    expect(q.default({ region: 'eu-west-2' })).toBe('clawops-state-614126170912-eu-west-2')
  })

  it('follows the region the operator picked two questions earlier', () => {
    const q = stateBucketQuestion('aws', '614126170912')
    expect(q.default({ region: 'us-east-1' })).not.toBe(q.default({ region: 'eu-west-2' }))
  })

  it('falls back to the provider default region when that question was skipped', () => {
    const q = stateBucketQuestion('aws', '614126170912')
    expect(q.default({})).toBe('clawops-state-614126170912-us-east-1')
  })

  it('suggests nothing rather than something wrong when no account resolved', () => {
    expect(stateBucketQuestion('gcp', undefined).default({})).toBeUndefined()
  })

  it('still suggests a name for Azure, which needs no account to be scoped', () => {
    expect(stateBucketQuestion('azure', undefined).default({})).toBe('clawops-state')
  })

  it('validates what is typed against the provider that has to accept it', () => {
    expect(stateBucketQuestion('aws', 'a').validate('my_bucket')).toContain('Underscores')
    expect(stateBucketQuestion('gcp', 'a').validate('my_bucket')).toBe(true)
  })

  it('no longer sends the operator to their cloud console', () => {
    expect(stateBucketQuestion('aws', 'a').message).not.toContain('console')
    expect(stateBucketQuestion('aws', 'a').message).not.toContain('create one first')
  })
})
