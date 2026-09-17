import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  deriveStateBucket, stateUrlFor, validateStateBucket, resolveScopeAccount,
} from '../../src/providers/state-bucket.js'

describe('a derived name carries the uniqueness its namespace demands', () => {
  it('scopes an S3 bucket to the account and the region', () => {
    expect(deriveStateBucket('aws', { account: '614126170912', region: 'us-east-1' }))
      .toEqual({ ok: true, name: 'clawops-state-614126170912-us-east-1' })
  })

  it('scopes a GCS bucket to the project, and does not name a region', () => {
    const derived = deriveStateBucket('gcp', { account: 'clawops-test', region: 'us-central1' })
    expect(derived).toEqual({ ok: true, name: 'clawops-state-clawops-test' })
  })

  it('gives an Azure container no discriminator — the storage account already scopes it', () => {
    expect(deriveStateBucket('azure', {})).toEqual({ ok: true, name: 'clawops-state' })
  })

  it('names an Azure container the same whatever account it is asked about', () => {
    expect(deriveStateBucket('azure', { account: 'sub-a', region: 'eastus' }))
      .toEqual(deriveStateBucket('azure', { account: 'sub-b', region: 'westus' }))
  })
})

describe('what it does when it cannot name one', () => {
  it('refuses rather than inventing a placeholder, and says what it needs — AWS', () => {
    const derived = deriveStateBucket('aws', { region: 'us-east-1' })
    expect(derived.ok).toBe(false)
    expect(derived.ok === false && derived.needs).toContain('AWS_PROFILE')
  })

  it('refuses rather than inventing a placeholder, and says what it needs — GCP', () => {
    const derived = deriveStateBucket('gcp', {})
    expect(derived.ok).toBe(false)
    expect(derived.ok === false && derived.needs).toContain('gcloud config set project')
  })

  it('will not name an S3 bucket without the region that bucket lives in', () => {
    const derived = deriveStateBucket('aws', { account: '614126170912' })
    expect(derived).toEqual({ ok: false, needs: 'a region' })
  })
})

describe('every derived name fits the provider that has to accept it', () => {
  // The longest inputs each cloud permits: AWS account ids are always 12 digits and its
  // longest region name is 14 characters; a GCP project id tops out at 30.
  const worst = {
    aws: deriveStateBucket('aws', { account: '614126170912', region: 'ap-southeast-4' }),
    gcp: deriveStateBucket('gcp', { account: 'a'.repeat(30) }),
    azure: deriveStateBucket('azure', {}),
  }

  it.each(Object.entries(worst))('%s stays inside 63 characters at its longest', (_p, derived) => {
    expect(derived.ok).toBe(true)
    expect(derived.ok === true && derived.name.length).toBeLessThanOrEqual(63)
  })

  it.each(['aws', 'gcp', 'azure'] as const)('%s validates its own longest name', (provider) => {
    const derived = worst[provider]
    expect(derived.ok === true && validateStateBucket(provider, derived.name)).toBe(true)
  })

  it('leaves real headroom on AWS rather than only just fitting', () => {
    expect(worst.aws.ok === true && worst.aws.name.length).toBe(41)
  })
})

describe('the state URL each name is addressed through', () => {
  it('gives S3 and GCS a prefix inside the bucket', () => {
    expect(stateUrlFor('aws', 'buck')).toBe('s3://buck/clawops')
    expect(stateUrlFor('gcp', 'buck')).toBe('gs://buck/clawops')
  })

  it('addresses an Azure container directly, with no prefix', () => {
    expect(stateUrlFor('azure', 'clawops-state')).toBe('azblob://clawops-state')
  })
})

describe('a name the operator typed is checked against the provider rules', () => {
  it('accepts an ordinary name everywhere', () => {
    for (const p of ['aws', 'gcp', 'azure'] as const) {
      expect(validateStateBucket(p, 'my-clawops-state')).toBe(true)
    }
  })

  it.each([
    ['', 'Required'],
    ['ab', 'Too short'],
    ['a'.repeat(64), 'Too long'],
    ['MyBucket', 'Lowercase only'],
    [' padded ', 'No leading or trailing spaces'],
  ])('rejects %j', (name, expected) => {
    expect(validateStateBucket('aws', name)).toContain(expected)
  })

  it('rejects a name that could be read as an IP address', () => {
    expect(validateStateBucket('aws', '192.168.0.1')).toContain('IP address')
  })

  it('rejects the S3 prefixes and suffixes AWS reserves', () => {
    expect(validateStateBucket('aws', 'xn--bucket')).toContain('xn--')
    expect(validateStateBucket('aws', 'sthree-bucket')).toContain('sthree-')
    expect(validateStateBucket('aws', 'bucket-s3alias')).toContain('-s3alias')
    expect(validateStateBucket('aws', 'bucket--ol-s3')).toContain('--ol-s3')
  })

  it('rejects an underscore on S3 but allows it on GCS', () => {
    expect(validateStateBucket('aws', 'my_bucket')).toContain('Underscores')
    expect(validateStateBucket('gcp', 'my_bucket')).toBe(true)
  })

  it('rejects the names Cloud Storage reserves for itself', () => {
    expect(validateStateBucket('gcp', 'googbucket')).toContain('goog')
    expect(validateStateBucket('gcp', 'my-google-bucket')).toContain('google')
  })

  it('lets those same names through on the clouds that do not reserve them', () => {
    expect(validateStateBucket('aws', 'my-google-bucket')).toBe(true)
    expect(validateStateBucket('azure', 'googbucket')).toBe(true)
  })

  it('rejects dots and doubled hyphens in an Azure container name', () => {
    expect(validateStateBucket('azure', 'my.bucket')).toContain('single hyphens')
    expect(validateStateBucket('azure', 'my--bucket')).toContain('single hyphens')
    expect(validateStateBucket('azure', '-bucket')).toContain('single hyphens')
    expect(validateStateBucket('gcp', 'my.bucket')).toBe(true)
  })

  it('rejects consecutive dots, which S3 and GCS both refuse', () => {
    expect(validateStateBucket('gcp', 'my..bucket')).toContain('consecutive dots')
  })

  it('names the resource the operator is being asked about', () => {
    expect(validateStateBucket('aws', 'ab')).toContain('S3 bucket')
    expect(validateStateBucket('gcp', 'ab')).toContain('Cloud Storage bucket')
    expect(validateStateBucket('azure', 'ab')).toContain('blob container')
  })
})

describe('resolving the account a name is scoped to', () => {
  beforeEach(() => vi.resetModules())

  it('does not ask any cloud about Azure, whose name needs no identity', async () => {
    expect(await resolveScopeAccount('azure')).toBeUndefined()
  })

  it('returns undefined rather than throwing when the credential chain fails', async () => {
    vi.doMock('../../src/providers/aws/preflight.js', () => ({
      callerAccount: () => { throw new Error('no credentials') },
    }))
    const { resolveScopeAccount: fresh } = await import('../../src/providers/state-bucket.js')
    await expect(fresh('aws')).resolves.toBeUndefined()
  })

  it('hands back the account STS reports', async () => {
    vi.doMock('../../src/providers/aws/preflight.js', () => ({
      callerAccount: async () => '614126170912',
    }))
    const { resolveScopeAccount: fresh } = await import('../../src/providers/state-bucket.js')
    await expect(fresh('aws')).resolves.toBe('614126170912')
  })
})

// ── raised by an automated review of #133 ────────────────────────────────────
describe('Cloud Storage allows a longer name when it is a dotted one', () => {
  const dotted = 'clawops-state.' + 'a'.repeat(60) + '.' + 'b'.repeat(60) + '.example.com'

  it('accepts a dotted GCS name past 63 characters', () => {
    expect(dotted.length).toBeGreaterThan(63)
    expect(validateStateBucket('gcp', dotted)).toBe(true)
  })

  it('still stops a dotted GCS name at 222', () => {
    const tooLong = 'a'.repeat(60) + ('.' + 'b'.repeat(60)).repeat(3)
    expect(tooLong.length).toBeGreaterThan(222)
    expect(validateStateBucket('gcp', tooLong)).toContain('222')
  })

  it('caps each dot-separated part at 63 even inside a long name', () => {
    expect(validateStateBucket('gcp', 'short.' + 'a'.repeat(64))).toContain('dot-separated')
  })

  it('leaves the undotted GCS limit at 63', () => {
    expect(validateStateBucket('gcp', 'a'.repeat(64))).toContain('63')
  })

  it('does not extend the allowance to S3, which caps every name at 63', () => {
    expect(validateStateBucket('aws', dotted)).toContain('63')
  })

  it('does not extend it to Azure, which has no dots at all', () => {
    expect(validateStateBucket('azure', dotted)).toContain('at most 63 characters')
    expect(validateStateBucket('azure', 'short.name')).toContain('single hyphens')
  })
})

describe('a state URL is only built from a name the provider would accept', () => {
  it.each([
    ['a slash', 'bucket/clawops'],
    ['a query string', 'bucket?region=elsewhere'],
    ['a fragment', 'bucket#x'],
    ['a traversal', 'bucket/../other'],
  ])('refuses to interpolate %s', (_what, name) => {
    expect(() => stateUrlFor('aws', name)).toThrow(/Not a usable aws state backend name/)
  })

  it('still builds a URL from any name that validates', () => {
    expect(stateUrlFor('gcp', 'clawops-state-my-project')).toBe('gs://clawops-state-my-project/clawops')
  })

  it('accepts every name clawops derives, on every cloud', () => {
    const derived = [
      deriveStateBucket('aws', { account: '614126170912', region: 'ap-southeast-4' }),
      deriveStateBucket('gcp', { account: 'a'.repeat(30) }),
      deriveStateBucket('azure', {}),
    ]
    for (const [i, d] of derived.entries()) {
      const provider = (['aws', 'gcp', 'azure'] as const)[i]!
      expect(d.ok).toBe(true)
      expect(() => stateUrlFor(provider, d.ok === true ? d.name : '')).not.toThrow()
    }
  })
})
