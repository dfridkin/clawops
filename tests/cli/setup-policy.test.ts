// The wizard's spending-limits step. Most CLI users set clawops up through the wizard, so the
// policy is toggled there as well as by editing ~/.clawops/config.json.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promptSpendingPolicy, allowedChoices, savePolicy } from '../../src/cli/setup-policy.js'

const AWS = [
  { name: 'micro', value: 'micro' },
  { name: 'small', value: 'small' },
  { name: 'medium', value: 'medium' },
  { name: 'large', value: 'large' },
]

/** Answers each prompt in turn, and records what was asked. */
function answering(...answers: Array<Record<string, unknown>>) {
  const asked: Array<Array<Record<string, unknown>>> = []
  const prompt = vi.fn(async (q: object[]) => {
    asked.push(q as Array<Record<string, unknown>>)
    return answers.shift() ?? {}
  })
  return { asked, inquirer: { prompt: prompt as unknown as <T>(q: object[]) => Promise<T> } }
}

beforeEach(() => {
  vi.stubEnv('CLAWOPS_HOME', mkdtempSync(path.join(tmpdir(), 'clawops-policy-')))
})

describe('promptSpendingPolicy', () => {
  it('changes nothing when the operator says no, and asks nothing else', async () => {
    const a = answering({ change: false })
    const out = await promptSpendingPolicy({ provider: 'aws', choices: AWS, current: undefined, stackCount: 0, inquirer: a.inquirer })
    expect(out).toBeUndefined()
    expect(a.asked).toHaveLength(1)
  })

  it('offers every size checked when there is no limit yet, and records the ones left checked', async () => {
    const a = answering({ change: true }, { sizes: ['micro', 'small'] }, { maxStacks: '3' })
    const out = await promptSpendingPolicy({ provider: 'aws', choices: AWS, current: undefined, stackCount: 1, inquirer: a.inquirer })
    const box = a.asked[1]![0]!
    expect((box.choices as Array<{ checked: boolean }>).every((c) => c.checked)).toBe(true)
    expect(out).toEqual({ allowedInstanceTypes: { aws: ['micro', 'small'] }, maxStacks: 3 })
  })

  it('pre-checks the current limit, and leaving every size checked removes it', async () => {
    const a = answering({ change: true }, { sizes: AWS.map((c) => c.value) }, { maxStacks: '' })
    const out = await promptSpendingPolicy({
      provider: 'aws', choices: AWS, stackCount: 0, inquirer: a.inquirer,
      current: { allowedInstanceTypes: { aws: ['small'], gcp: ['micro'] }, maxStacks: 2 },
    })
    const checked = (a.asked[1]![0]!.choices as Array<{ value: string; checked: boolean }>)
      .filter((c) => c.checked).map((c) => c.value)
    expect(checked).toEqual(['small'])
    // aws is unrestricted now; gcp's limit is untouched; a blank cap removes the cap.
    expect(out).toEqual({ allowedInstanceTypes: { gcp: ['micro'] } })
  })

  it('asks only for the deployment cap on a local deployment', async () => {
    const a = answering({ change: true }, { maxStacks: '1' })
    const out = await promptSpendingPolicy({ provider: undefined, choices: [], current: undefined, stackCount: 0, inquirer: a.inquirer })
    expect(a.asked).toHaveLength(2)
    expect(out).toEqual({ maxStacks: 1 })
  })
})

describe('allowedChoices', () => {
  it('offers only the sizes the policy allows', async () => {
    const out = await allowedChoices('aws', AWS, { allowedInstanceTypes: { aws: ['t3.small', 'medium'] } })
    expect(out.map((c) => c.value)).toEqual(['small', 'medium'])
  })

  it('offers an allowed native type that is not a clawops size, so the list is never empty', async () => {
    const out = await allowedChoices('aws', AWS, { allowedInstanceTypes: { aws: ['c7g.large'] } })
    expect(out.map((c) => c.value)).toEqual(['c7g.large'])
  })

  it('offers everything when there is no policy', async () => {
    expect(await allowedChoices('aws', AWS, undefined)).toEqual(AWS)
  })
})

describe('savePolicy', () => {
  it('reports that there was nothing to save into on a first run', async () => {
    expect(await savePolicy({ maxStacks: 2 })).toBe(false)
  })

  it('writes the policy into an existing config, and an empty policy removes the block', async () => {
    const { initStack } = await import('../../src/config/init.js')
    const { getConfig } = await import('../../src/config/store.js')
    await initStack({ provider: 'aws', stateUrl: 's3://b/clawops', stackName: 'prod' })
    expect(await savePolicy({ maxStacks: 2 })).toBe(true)
    expect(getConfig()!.policy).toEqual({ maxStacks: 2 })
    expect(await savePolicy({})).toBe(true)
    expect(getConfig()!.policy).toBeUndefined()
  })
})
