import { describe, it, expect } from 'vitest'
import { resolveInferenceProfile, geographyFor } from '../../src/openclaw/bedrock.js'

// Bedrock refuses bare foundation-model ids for on-demand inference:
//
//   Invocation of model ID anthropic.claude-haiku-4-5-... with on-demand throughput isn't
//   supported. Retry your request with the ID or ARN of an inference profile...
//
// All ten Bedrock models in spec/models.yaml are bare ids, so every one of them failed that
// way. The usable id is region-dependent, which is why it is resolved rather than stored.

const profiles = [
  { inferenceProfileId: 'us.anthropic.claude-sonnet-4-6' },
  { inferenceProfileId: 'global.anthropic.claude-sonnet-4-6' },
  { inferenceProfileId: 'eu.anthropic.claude-haiku-4-5' },
  { inferenceProfileId: 'apac.amazon.nova-pro-v1:0' },
  { inferenceProfileId: 'global.meta.llama3-3-70b-instruct-v1:0' },
]

describe('geographyFor', () => {
  it.each([
    ['us-east-1', 'us'], ['us-west-2', 'us'],
    ['eu-west-1', 'eu'], ['eu-central-1', 'eu'],
    ['ap-southeast-2', 'apac'], ['ap-northeast-1', 'apac'],
  ])('%s → %s', (region, geo) => expect(geographyFor(region)).toBe(geo))

  it('leaves an unrecognised prefix alone rather than guessing', () => {
    // It will then match no profile and produce a clear refusal, which beats routing
    // inference to a geography the operator did not choose.
    expect(geographyFor('xx-somewhere-1')).toBe('xx')
  })
})

describe('resolveInferenceProfile', () => {
  it('prefers the profile for the deployment’s own geography', () => {
    const r = resolveInferenceProfile('anthropic.claude-sonnet-4-6', profiles, 'us-east-1')
    expect(r.ok && r.profileId).toBe('us.anthropic.claude-sonnet-4-6')
  })

  it('falls back to global when the geography has no profile', () => {
    const r = resolveInferenceProfile('meta.llama3-3-70b-instruct-v1:0', profiles, 'us-east-1')
    expect(r.ok && r.profileId).toBe('global.meta.llama3-3-70b-instruct-v1:0')
    expect(r.ok && r.why).toMatch(/global/)
  })

  it('refuses a model with no profile at all', () => {
    const r = resolveInferenceProfile('made.up-model', profiles, 'us-east-1')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/No Bedrock inference profile/)
  })

  it('refuses rather than routing inference to another geography', () => {
    // apac has a nova profile; a eu-west-1 deployment must not silently use it.
    const r = resolveInferenceProfile('amazon.nova-pro-v1:0', profiles, 'eu-west-1')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/another\s+geography/)
  })

  it('matches on the full id, not a substring', () => {
    // `anthropic.claude-sonnet-4` must not match `us.anthropic.claude-sonnet-4-6`, or a
    // deployment silently runs a different model than the one chosen.
    const r = resolveInferenceProfile('anthropic.claude-sonnet-4', profiles, 'us-east-1')
    expect(r.ok).toBe(false)
  })

  it('does not treat a bare id as its own profile', () => {
    const r = resolveInferenceProfile(
      'anthropic.claude-sonnet-4-6',
      [{ inferenceProfileId: 'anthropic.claude-sonnet-4-6' }],
      'us-east-1',
    )
    expect(r.ok).toBe(false)
  })

  it('says nothing is available when the region lists no profiles', () => {
    const r = resolveInferenceProfile('anthropic.claude-sonnet-4-6', [], 'us-east-1')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/us-east-1/)
  })
})
