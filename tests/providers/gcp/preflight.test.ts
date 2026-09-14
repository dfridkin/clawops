import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { mockGetClient } = vi.hoisted(() => ({ mockGetClient: vi.fn() }))
vi.mock('google-auth-library', () => ({
  GoogleAuth: vi.fn().mockImplementation(() => ({ getClient: mockGetClient })),
}))

import path from 'node:path'
import process from 'node:process'
import { tmpdir } from 'node:os'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import {
  gcpPreflight, resolveProjectId, projectFromIni,
} from '../../../src/providers/gcp/preflight.js'

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

// Every project-resolution source, cleared for every test. The suite used to clear one env
// var and call that "no project resolved" — which held only on a machine with no gcloud
// config. It has one now, and the assertion started failing on a change that broke nothing:
// the test was reading the developer's machine, not the code.
const PROJECT_ENV = [
  'GOOGLE_PROJECT',
  'GOOGLE_CLOUD_PROJECT',
  'GCLOUD_PROJECT',
  'CLOUDSDK_CORE_PROJECT',
  'CLOUDSDK_CONFIG',
  'CLOUDSDK_ACTIVE_CONFIG_NAME',
] as const
const savedEnv: Record<string, string | undefined> = {}
let emptyGcloudDir: string

beforeEach(() => {
  mockGetClient.mockReset()
  mockGetClient.mockResolvedValue({ getAccessToken: async () => ({ token: 'tok' }) })
  for (const v of PROJECT_ENV) {
    savedEnv[v] = process.env[v]
    delete process.env[v]
  }
  // An empty directory, so the gcloud fallback finds nothing rather than the real machine's
  // configured project.
  emptyGcloudDir = mkdtempSync(path.join(tmpdir(), 'gcloud-empty-'))
  process.env['CLOUDSDK_CONFIG'] = emptyGcloudDir
  process.env['GOOGLE_CLOUD_PROJECT'] = 'proj'
})
afterEach(() => {
  restoreFetch?.()
  restoreFetch = undefined
  for (const v of PROJECT_ENV) {
    if (savedEnv[v] === undefined) delete process.env[v]
    else process.env[v] = savedEnv[v]
  }
  rmSync(emptyGcloudDir, { recursive: true, force: true })
})

describe('resolveProjectId', () => {
  it.each(['GOOGLE_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT', 'CLOUDSDK_CORE_PROJECT'])(
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

describe('projectFromIni', () => {
  it('reads project from the [core] section', () => {
    expect(projectFromIni('[core]\naccount = a@b.c\nproject = clawops-test\n')).toBe('clawops-test')
  })

  it('ignores a project setting in another section', () => {
    // `compute/project` is a different setting; taking it would deploy somewhere unasked.
    expect(projectFromIni('[compute]\nproject = other\n')).toBeUndefined()
    expect(projectFromIni('[compute]\nproject = other\n[core]\nproject = mine\n')).toBe('mine')
  })

  it('stops reading [core] once another section starts', () => {
    expect(projectFromIni('[core]\nproject = mine\n[compute]\nproject = other\n')).toBe('mine')
    expect(projectFromIni('[core]\naccount = a\n[compute]\nproject = other\n')).toBeUndefined()
  })

  it('tolerates spacing, comments and blank lines', () => {
    expect(projectFromIni('\n# a comment\n; another\n[core]\n\n  project   =   spaced  \n')).toBe(
      'spaced',
    )
  })

  it('treats an empty value as no answer', () => {
    expect(projectFromIni('[core]\nproject =\n')).toBeUndefined()
  })

  it('does not match a key that merely ends in project', () => {
    expect(projectFromIni('[core]\nquota_project = q\n')).toBeUndefined()
  })

  it('returns undefined for a file with no project at all', () => {
    expect(projectFromIni('[core]\naccount = a@b.c\n')).toBeUndefined()
  })
})

describe('resolveProjectId', () => {
  const VARS = [
    'GOOGLE_PROJECT',
    'GOOGLE_CLOUD_PROJECT',
    'GCLOUD_PROJECT',
    'CLOUDSDK_CORE_PROJECT',
    'CLOUDSDK_CONFIG',
    'CLOUDSDK_ACTIVE_CONFIG_NAME',
  ] as const
  const saved: Record<string, string | undefined> = {}
  let dir: string

  beforeEach(() => {
    for (const v of VARS) {
      saved[v] = process.env[v]
      delete process.env[v]
    }
    dir = mkdtempSync(path.join(tmpdir(), 'gcloud-'))
    process.env['CLOUDSDK_CONFIG'] = dir
  })
  afterEach(() => {
    for (const v of VARS) {
      if (saved[v] === undefined) delete process.env[v]
      else process.env[v] = saved[v]
    }
    rmSync(dir, { recursive: true, force: true })
  })

  function writeConfig(name: string, project: string) {
    mkdirSync(path.join(dir, 'configurations'), { recursive: true })
    writeFileSync(path.join(dir, 'configurations', `config_${name}`), `[core]\nproject = ${project}\n`)
  }

  it('prefers GOOGLE_PROJECT, the provider\'s own first choice', () => {
    process.env['GOOGLE_PROJECT'] = 'from-google-project'
    process.env['GOOGLE_CLOUD_PROJECT'] = 'from-cloud-project'
    writeConfig('default', 'from-gcloud')
    writeFileSync(path.join(dir, 'active_config'), 'default')
    expect(resolveProjectId()).toBe('from-google-project')
  })

  it('falls through the env vars in the provider\'s order', () => {
    process.env['GCLOUD_PROJECT'] = 'third'
    process.env['CLOUDSDK_CORE_PROJECT'] = 'fourth'
    expect(resolveProjectId()).toBe('third')
  })

  it('reads the active gcloud configuration when no env var answers', () => {
    // The check's remedy says `gcloud config set project`. This is what makes that true.
    writeFileSync(path.join(dir, 'active_config'), 'default')
    writeConfig('default', 'from-gcloud')
    expect(resolveProjectId()).toBe('from-gcloud')
  })

  it('follows active_config to a non-default configuration', () => {
    writeFileSync(path.join(dir, 'active_config'), 'work')
    writeConfig('work', 'work-project')
    writeConfig('default', 'default-project')
    expect(resolveProjectId()).toBe('work-project')
  })

  it('lets CLOUDSDK_ACTIVE_CONFIG_NAME override active_config', () => {
    writeFileSync(path.join(dir, 'active_config'), 'default')
    writeConfig('default', 'default-project')
    writeConfig('work', 'work-project')
    process.env['CLOUDSDK_ACTIVE_CONFIG_NAME'] = 'work'
    expect(resolveProjectId()).toBe('work-project')
  })

  it('is undefined when there is no gcloud config at all', () => {
    expect(resolveProjectId()).toBeUndefined()
  })

  it('is undefined, not an error, when the config names a file that is not there', () => {
    writeFileSync(path.join(dir, 'active_config'), 'missing')
    expect(() => resolveProjectId()).not.toThrow()
    expect(resolveProjectId()).toBeUndefined()
  })
})
