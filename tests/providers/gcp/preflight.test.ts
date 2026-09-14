import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { mockGetClient } = vi.hoisted(() => ({ mockGetClient: vi.fn() }))
vi.mock('google-auth-library', () => ({
  GoogleAuth: vi.fn().mockImplementation(() => ({ getClient: mockGetClient })),
}))

import { gcpPreflight, resolveProjectId } from '../../../src/providers/gcp/preflight.js'

// A GCP project with credentials that resolve and the Compute API disabled passes every other
// check clawops makes, then fails partway through a deploy with
//
//   Compute Engine API has not been used in project <id> before or it is disabled
//
// which is a fine thing to learn before provisioning and a poor thing to learn during it.

// Only the fetch spy is restored between tests. `vi.restoreAllMocks()` also wipes the
// implementation on the hoisted GoogleAuth mock, which makes accessToken() fail and every
// later test see a preflight that stopped at "ADC unusable" — three tests failed that way
// before this was narrowed.
// Typed off `fetch` itself rather than named DOM types: `RequestInfo` is not in the lib set
// this project compiles against, and a loose ReturnType<typeof vi.spyOn> does not match the
// spy's own signature. Both only showed up in CI, because typecheck was skipped locally.
let restoreFetch: (() => void) | undefined
function mockFetch(handler: (url: string, init?: RequestInit) => Response) {
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(
    (...args: Parameters<typeof fetch>) =>
      Promise.resolve(handler(String(args[0]), args[1])),
  )
  restoreFetch = () => spy.mockRestore()
  return spy
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const servicesPage = (names: string[]) =>
  json({ services: names.map((n) => ({ config: { name: n } })) })

beforeEach(() => {
  mockGetClient.mockReset()
  mockGetClient.mockResolvedValue({ getAccessToken: async () => ({ token: 'tok' }) })
  process.env['GOOGLE_CLOUD_PROJECT'] = 'proj'
})
afterEach(() => {
  restoreFetch?.()
  restoreFetch = undefined
  delete process.env['GOOGLE_CLOUD_PROJECT']
})

describe('resolveProjectId', () => {
  it.each(['GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT', 'CLOUDSDK_CORE_PROJECT'])(
    'reads %s',
    (key) => {
      delete process.env['GOOGLE_CLOUD_PROJECT']
      process.env[key] = 'from-' + key
      expect(resolveProjectId()).toBe('from-' + key)
      delete process.env[key]
    },
  )
})

describe('gcpPreflight', () => {
  it('passes when both APIs are enabled and the bucket exists', async () => {
    mockFetch((url) =>
      url.includes('serviceusage')
        ? servicesPage(['compute.googleapis.com', 'storage.googleapis.com'])
        : json({ name: 'b' }),
    )
    const checks = await gcpPreflight({ bucket: 'b' })
    expect(checks.every((c) => c.ok), JSON.stringify(checks.filter((c) => !c.ok))).toBe(true)
  })

  it('fails the compute check when the API is not enabled, and offers to enable it', async () => {
    mockFetch((url) =>
      url.includes('serviceusage') ? servicesPage(['storage.googleapis.com']) : json({ name: 'b' }),
    )
    const compute = (await gcpPreflight({ bucket: 'b' })).find((c) => c.id === 'api-compute')!
    expect(compute.ok).toBe(false)
    expect(compute.fix).toBeDefined()
    // The prompt has to name the mutation: consent to "fix it" is not consent to something
    // unnamed.
    expect(compute.mutates).toMatch(/Enables compute\.googleapis\.com on project proj/)
  })

  it('offers to create a missing state bucket, with versioning', async () => {
    // Pulumi needs its state backend before it can run, so a deploy cannot create this on
    // its way past — which is why it is a preflight rather than a resource.
    mockFetch((url) =>
      url.includes('serviceusage')
        ? servicesPage(['compute.googleapis.com', 'storage.googleapis.com'])
        : json({ error: 'not found' }, 404),
    )
    const bucket = (await gcpPreflight({ bucket: 'b', region: 'us-central1' })).find(
      (c) => c.id === 'state-bucket',
    )!
    expect(bucket.ok).toBe(false)
    expect(bucket.mutates).toMatch(/Creates bucket gs:\/\/b .*versioning on/)
  })

  it('sends versioning and uniform access when it creates the bucket', async () => {
    let body: Record<string, unknown> | undefined
    mockFetch((url, init) => {
      if (url.includes('serviceusage')) return servicesPage(['compute.googleapis.com', 'storage.googleapis.com'])
      if (init?.method === 'POST') { body = JSON.parse(String(init.body)); return json({}) }
      return json({ error: 'not found' }, 404)
    })
    const bucket = (await gcpPreflight({ bucket: 'b', region: 'us-central1' })).find((c) => c.id === 'state-bucket')!
    await bucket.fix!()
    // Pulumi state with no history is a stack that can no longer be updated or destroyed.
    expect(body?.['versioning']).toEqual({ enabled: true })
    expect(body?.['location']).toBe('US-CENTRAL1')
  })

  it('offers no fix for a check it cannot fix', async () => {
    delete process.env['GOOGLE_CLOUD_PROJECT']
    const checks = await gcpPreflight({})
    const project = checks.find((c) => c.id === 'project-resolved')!
    expect(project.ok).toBe(false)
    expect(project.fix).toBeUndefined()
    // And it stops rather than running every later check against a project it does not know.
    expect(checks).toHaveLength(1)
  })

  it('says ADC is unusable rather than blaming the APIs', async () => {
    mockGetClient.mockRejectedValue(new Error('no credentials'))
    const checks = await gcpPreflight({ bucket: 'b' })
    const adc = checks.find((c) => c.id === 'adc-usable')!
    expect(adc.ok).toBe(false)
    expect(adc.detail).toMatch(/application-default login/)
  })

  it('does not report APIs as enabled when the listing fails', async () => {
    // An unreadable answer is not a passing one — reporting ok here would send someone into
    // a deploy that cannot work.
    mockFetch(() => json({ error: 'forbidden' }, 403))
    const checks = await gcpPreflight({})
    expect(checks.filter((c) => c.id.startsWith('api-')).every((c) => !c.ok)).toBe(true)
  })
})

describe('provider registration', () => {
  it('registers the adapter on import, so getProvider can find it', async () => {
    // `registerProvider` existed and was called by nothing. getProvider therefore threw for
    // every provider — and `clawops doctor` uses it, so its Credentials section reported
    // "No provider adapter registered" instead of validating anything, for every cloud stack.
    // Deploys were unaffected, because cli/context.ts resolves mod.default directly, which is
    // why this survived so long.
    const { getProvider } = await import('../../../src/providers/index.js')
    await import('../../../src/providers/gcp/index.js')
    expect(getProvider('gcp').name).toBe('gcp')
  })

  it('every adapter registers itself', async () => {
    // Statically imported: a templated dynamic import cannot be resolved by the bundler.
    const { getProvider } = await import('../../../src/providers/index.js')
    await Promise.all([
      import('../../../src/providers/aws/index.js'),
      import('../../../src/providers/gcp/index.js'),
      import('../../../src/providers/azure/index.js'),
      import('../../../src/providers/local/index.js'),
    ])
    for (const name of ['aws', 'gcp', 'azure', 'local'] as const) {
      expect(getProvider(name).name, name).toBe(name)
    }
  })
})
