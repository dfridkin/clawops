// The operator's spending policy. It lives in config, not in the plan, because the plan is what
// an agent writes; see src/config/policy.ts.

import { describe, it, expect } from 'vitest'
import { enforceInstanceType, stackCapRefusal, allowedTypesFor } from '../../src/config/policy.js'
import type { ClawopsConfig } from '../../src/config/store.js'

function config(policy?: ClawopsConfig['policy'], stacks: string[] = ['prod']): ClawopsConfig {
  return {
    version: 1,
    defaults: { stack: stacks[0] ?? 'prod', provider: 'aws' },
    stacks: Object.fromEntries(stacks.map((n) => [n, {
      provider: 'aws', stateUrl: 's3://b/clawops', credentialsRef: { source: 'env' as const },
    }])),
    ssh: { keyPath: '/k', knownHostsPath: '/kh' },
    ...(policy ? { policy } : {}),
  }
}

describe('instance-type allowlist', () => {
  it('allows anything when there is no policy, or none for this provider', async () => {
    await expect(enforceInstanceType(config(), 'aws', 'g4dn.xlarge')).resolves.toBeUndefined()
    const gcpOnly = config({ allowedInstanceTypes: { gcp: ['small'] } })
    await expect(enforceInstanceType(gcpOnly, 'aws', 'g4dn.xlarge')).resolves.toBeUndefined()
  })

  it('compares clawops sizes and native types after mapping them', async () => {
    // `small` is t3.small on AWS: allowing either allows both spellings.
    const bySize = config({ allowedInstanceTypes: { aws: ['small'] } })
    await expect(enforceInstanceType(bySize, 'aws', 't3.small')).resolves.toBeUndefined()
    await expect(enforceInstanceType(bySize, 'aws', 'small')).resolves.toBeUndefined()
    const byType = config({ allowedInstanceTypes: { aws: ['t3.small'] } })
    await expect(enforceInstanceType(byType, 'aws', 'small')).resolves.toBeUndefined()
  })

  it('refuses a type outside the list, saying what is allowed and where it is set', async () => {
    const p = config({ allowedInstanceTypes: { aws: ['micro', 'small'] } })
    const err = await enforceInstanceType(p, 'aws', 'g4dn.xlarge').then(() => undefined, (e: Error) => e)
    expect(err?.name).toBe('UsageError')
    expect(err?.message).toContain('"g4dn.xlarge" is not allowed on aws')
    expect(err?.message).toContain('t3.micro, t3.small')
    expect(err?.message).toContain('policy.allowedInstanceTypes.aws')
  })

  it('maps the allowlist to native types once, without duplicates', async () => {
    const allowed = await allowedTypesFor({ allowedInstanceTypes: { aws: ['small', 't3.small'] } }, 'aws')
    expect(allowed).toEqual(['t3.small'])
  })
})

describe('stack cap', () => {
  it('has no cap without a policy', () => {
    expect(stackCapRefusal(config(undefined, ['a', 'b', 'c']), 'd')).toBeUndefined()
  })

  it('allows a new stack under the cap and refuses one at it', () => {
    expect(stackCapRefusal(config({ maxStacks: 2 }, ['a']), 'b')).toBeUndefined()
    const refused = stackCapRefusal(config({ maxStacks: 2 }, ['a', 'b']), 'c')
    expect(refused).toContain('allows 2 stacks')
    expect(refused).toContain('2 exist: a, b')
  })

  it('does not count re-registering a stack that already exists', () => {
    expect(stackCapRefusal(config({ maxStacks: 1 }, ['a']), 'a')).toBeUndefined()
  })
})
