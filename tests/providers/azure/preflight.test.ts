import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { mockSpawnSync } = vi.hoisted(() => ({ mockSpawnSync: vi.fn() }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawnSync: mockSpawnSync }
})

import {
  azurePreflight, stateBackendCheck, managementToken, REQUIRED_PROVIDERS,
  sizeCheck, availableSizes,
} from '../../../src/providers/azure/preflight.js'

const SUB = 'sub-0001'
const VARS = [
  'ARM_SUBSCRIPTION_ID',
  'AZURE_SUBSCRIPTION_ID',
  'AZURE_CONFIG_DIR',
  'AZURE_TENANT_ID',
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
  'AZURE_STORAGE_ACCOUNT',
  'AZURE_STORAGE_KEY',
  'AZURE_STORAGE_SAS_TOKEN',
] as const
const saved: Record<string, string | undefined> = {}
let restoreFetch: (() => void) | undefined

beforeEach(() => {
  for (const v of VARS) {
    saved[v] = process.env[v]
    delete process.env[v]
  }
  // A config dir that does not exist, so the CLI profile on the machine running these tests
  // cannot answer for them.
  process.env['AZURE_CONFIG_DIR'] = '/nonexistent-azure-config'
  process.env['ARM_SUBSCRIPTION_ID'] = SUB
  // The service-principal path needs nothing spawned, which keeps these tests off `az`.
  process.env['AZURE_TENANT_ID'] = 'tenant'
  process.env['AZURE_CLIENT_ID'] = 'client'
  process.env['AZURE_CLIENT_SECRET'] = 'secret'
  mockSpawnSync.mockReset()
})
afterEach(() => {
  restoreFetch?.()
  restoreFetch = undefined
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v]
    else process.env[v] = saved[v]
  }
})

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(((url: string, init?: RequestInit) =>
    Promise.resolve(handler(String(url), init))) as unknown as typeof fetch)
  restoreFetch = () => spy.mockRestore()
  return spy
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** ARM answering with these registration states, and a token endpoint that works. */
function arm(states: Record<string, string>) {
  return mockFetch((url) => {
    if (url.includes('login.microsoftonline.com')) return json({ access_token: 'tok' })
    const ns = Object.keys(states).find((n) => url.includes(`/providers/${n}?`))
    if (ns) return json({ registrationState: states[ns] })
    if (url.includes('/register?')) return json({})
    return json({ error: 'unexpected' }, 404)
  })
}

const REGISTERED = {
  'Microsoft.Compute': 'Registered',
  'Microsoft.Network': 'Registered',
  'Microsoft.Storage': 'Registered',
}

function find(checks: Awaited<ReturnType<typeof azurePreflight>>, id: string) {
  return checks.find((c) => c.id === id)
}

describe('stateBackendCheck', () => {
  it('fails when nothing names a storage account', () => {
    const check = stateBackendCheck('clawops-state')
    expect(check.ok).toBe(false)
    // Every credential check can pass and the deploy still fail to open its own state, so the
    // detail has to say why this one is different.
    expect(check.detail).toMatch(/not.*with your `az login`/)
  })

  it('fails with an account but no secret', () => {
    process.env['AZURE_STORAGE_ACCOUNT'] = 'acct'
    expect(stateBackendCheck('c').ok).toBe(false)
  })

  it('passes with an account key', () => {
    process.env['AZURE_STORAGE_ACCOUNT'] = 'acct'
    process.env['AZURE_STORAGE_KEY'] = 'key'
    expect(stateBackendCheck('c').ok).toBe(true)
  })

  it('passes with a SAS token instead', () => {
    process.env['AZURE_STORAGE_ACCOUNT'] = 'acct'
    process.env['AZURE_STORAGE_SAS_TOKEN'] = 'sas'
    expect(stateBackendCheck('c').ok).toBe(true)
  })

  it('names the container when one is known', () => {
    process.env['AZURE_STORAGE_ACCOUNT'] = 'acct'
    process.env['AZURE_STORAGE_KEY'] = 'key'
    expect(stateBackendCheck('clawops-state').detail).toContain('azblob://clawops-state')
  })

  it('offers no fix — clawops does not invent a storage account', () => {
    expect(stateBackendCheck('c').fix).toBeUndefined()
  })
})

describe('managementToken', () => {
  it('exchanges a service principal over HTTP, needing nothing installed', async () => {
    arm(REGISTERED)
    await expect(managementToken()).resolves.toBe('tok')
    expect(mockSpawnSync).not.toHaveBeenCalled()
  })

  it('asks the CLI when there is no service principal', async () => {
    delete process.env['AZURE_CLIENT_SECRET']
    mockSpawnSync.mockReturnValue({ status: 0, stdout: 'cli-token\n' })
    await expect(managementToken()).resolves.toBe('cli-token')
    expect(String(mockSpawnSync.mock.calls[0]?.[0])).toBe('az')
  })

  it('is undefined when the CLI is not installed', async () => {
    delete process.env['AZURE_CLIENT_SECRET']
    mockSpawnSync.mockReturnValue({ status: null, stdout: '', error: new Error('spawn ENOENT') })
    await expect(managementToken()).resolves.toBeUndefined()
  })

  it('is undefined when the token endpoint refuses the credentials', async () => {
    mockFetch(() => json({ error: 'invalid_client' }, 401))
    await expect(managementToken()).resolves.toBeUndefined()
  })
})

describe('azurePreflight', () => {
  it('passes when every provider is registered and the backend is configured', async () => {
    process.env['AZURE_STORAGE_ACCOUNT'] = 'acct'
    process.env['AZURE_STORAGE_KEY'] = 'key'
    arm(REGISTERED)
    const checks = await azurePreflight({ bucket: 'clawops-state' })
    expect(checks.every((c) => c.ok)).toBe(true)
  })

  it('reports an unregistered provider, and offers to register it', async () => {
    // A fresh subscription has all three unregistered, and the only sign is a deploy failing
    // partway with "The subscription is not registered to use namespace 'Microsoft.Compute'".
    arm({ ...REGISTERED, 'Microsoft.Compute': 'NotRegistered' })
    const check = find(await azurePreflight({}), 'rp-compute')!
    expect(check.ok).toBe(false)
    expect(check.detail).toMatch(/virtual machine/)
    expect(check.fix).toBeDefined()
    expect(check.mutates).toMatch(/Registers the Microsoft.Compute resource provider/)
  })

  it('names what its fix will change, since consent to "fix it" is not consent to anything', async () => {
    arm({ ...REGISTERED, 'Microsoft.Network': 'NotRegistered' })
    for (const check of await azurePreflight({})) {
      if (check.fix) expect(check.mutates).toBeTruthy()
    }
  })

  it('registers the namespace its fix names', async () => {
    const posted: string[] = []
    mockFetch((url, init) => {
      if (url.includes('login.microsoftonline.com')) return json({ access_token: 'tok' })
      if (init?.method === 'POST') {
        posted.push(url)
        return json({})
      }
      return json({ registrationState: 'NotRegistered' })
    })
    const check = find(await azurePreflight({}), 'rp-storage')!
    await check.fix!()
    expect(posted.some((u) => u.includes('Microsoft.Storage/register'))).toBe(true)
  })

  it('stops at the subscription when none is resolved', async () => {
    delete process.env['ARM_SUBSCRIPTION_ID']
    const checks = await azurePreflight({})
    expect(checks).toHaveLength(1)
    expect(checks[0]?.ok).toBe(false)
    expect(checks[0]?.fix).toBeUndefined()
  })

  it('still reports the state backend when no token can be had', async () => {
    // The backend check is pure environment, and it is the failure that looks least like its
    // cause — so it is worth answering even when the API is unreachable.
    delete process.env['AZURE_CLIENT_SECRET']
    mockSpawnSync.mockReturnValue({ status: 1, stdout: '' })
    mockFetch(() => json({}, 500))
    const checks = await azurePreflight({ bucket: 'c' })
    expect(find(checks, 'state-backend-credentials')).toBeDefined()
    expect(find(checks, 'management-token')?.ok).toBe(false)
    expect(find(checks, 'rp-compute')).toBeUndefined()
  })

  it('checks the VM size when a region is known', async () => {
    mockFetch((url) => {
      if (url.includes('login.microsoftonline.com')) return json({ access_token: 'tok' })
      if (url.includes('/skus')) return json({ value: [] })
      return json({ registrationState: 'Registered' })
    })
    const checks = await azurePreflight({ region: 'eastus' })
    expect(find(checks, 'vm-size-available')).toBeDefined()
  })

  it('asks about the size the caller named, not the provider default', async () => {
    // A stack deployed with --instance-type would otherwise be reported as broken because a
    // size it does not use is unavailable — which is exactly what the Azure e2e hit.
    mockFetch((url) => {
      if (url.includes('login.microsoftonline.com')) return json({ access_token: 'tok' })
      if (url.includes('/skus')) {
        return json({
          value: [
            { name: 'Standard_D2als_v7', resourceType: 'virtualMachines', restrictions: [] },
          ],
        })
      }
      return json({ registrationState: 'Registered' })
    })
    const checks = await azurePreflight({
      region: 'eastus',
      instanceType: 'Standard_D2als_v7',
    })
    const size = find(checks, 'vm-size-available')!
    expect(size.ok).toBe(true)
    expect(size.label).toContain('Standard_D2als_v7')
  })

  it('skips the size check when no region is known, rather than guessing one', async () => {
    arm(REGISTERED)
    expect(find(await azurePreflight({}), 'vm-size-available')).toBeUndefined()
  })

  it('covers every provider the program needs', async () => {
    arm(REGISTERED)
    const checks = await azurePreflight({})
    for (const p of REQUIRED_PROVIDERS) {
      expect(checks.some((c) => c.label.startsWith(p.namespace))).toBe(true)
    }
  })

  it('treats an unreadable registration state as not registered', async () => {
    mockFetch((url) => {
      if (url.includes('login.microsoftonline.com')) return json({ access_token: 'tok' })
      return json({ error: 'forbidden' }, 403)
    })
    expect(find(await azurePreflight({}), 'rp-compute')?.ok).toBe(false)
  })
})

describe('sizeCheck', () => {
  const AVAILABLE = new Set([
    'Standard_D2als_v7',
    'Standard_D2as_v7',
    'Standard_D4as_v7',
    'Standard_D248ds_v7',
  ])

  it('passes when the size is offered', () => {
    expect(sizeCheck('eastus', new Set(['Standard_B2s'])).ok).toBe(true)
  })

  it('fails when it is not, and says the deploy gets that far first', () => {
    // The subscription this was first run against was offered no B-series size at all in
    // eastus, and the 409 arrives after the network, NSG, public IP and NIC exist.
    const check = sizeCheck('eastus', AVAILABLE)
    expect(check.ok).toBe(false)
    expect(check.detail).toMatch(/after the network, NSG, public IP and NIC have been created/)
  })

  it('suggests sizes of a similar shape, not whatever sorts first', () => {
    const check = sizeCheck('eastus', AVAILABLE)
    expect(check.detail).toContain('Standard_D2as_v7')
    // A 248-vCPU machine is not an alternative to a 2-vCPU one.
    expect(check.detail).not.toContain('Standard_D248ds_v7')
  })

  it('caps the suggestions rather than printing a catalogue', () => {
    const many = new Set(
      Array.from({ length: 40 }, (_, i) => `Standard_D2a${String.fromCharCode(97 + (i % 26))}s_v7`),
    )
    // Count the listed sizes, not every comma in the sentence — the prose around them has
    // commas of its own, and counting those measures the wrong thing.
    const detail = sizeCheck('eastus', many).detail ?? ''
    const listed = detail.match(/Available instead: ([^—]+)/)?.[1]?.split(',') ?? []
    expect(listed.length).toBeLessThanOrEqual(4)
    expect(listed.length).toBeGreaterThan(0)
  })

  it('says to try another region when nothing similar is offered', () => {
    expect(sizeCheck('eastus', new Set(['Standard_D248ds_v7'])).detail).toMatch(/another region/)
  })

  it('reports a failed listing as unknown, not as availability or as a fault', () => {
    // The subscription may well be offered this size; clawops could not ask. Failing over a
    // denied read would be as wrong as passing.
    const check = sizeCheck('eastus', undefined)
    expect(check.ok).toBe(false)
    expect(check.unknown).toBe(true)
    expect(check.detail).toMatch(/could not list the VM sizes/)
    expect(check.detail).toMatch(/Microsoft.Compute\/skus/)
  })

  it('checks the size a plan gets by default', () => {
    // `small` is what a plan uses when nobody says otherwise, so it is the one worth checking.
    expect(sizeCheck('eastus', new Set()).label).toContain('Standard_B2s')
  })

  it('can be asked about a specific size', () => {
    expect(sizeCheck('eastus', new Set(['Standard_D2as_v7']), 'Standard_D2as_v7').ok).toBe(true)
  })
})

describe('availableSizes', () => {
  const skus = (value: unknown[]) => json({ value })

  it('keeps only virtual machine SKUs', async () => {
    mockFetch(() => skus([
      { name: 'Standard_D2as_v7', resourceType: 'virtualMachines', restrictions: [] },
      { name: 'Premium_LRS', resourceType: 'disks', restrictions: [] },
    ]))
    const sizes = await availableSizes('sub', 'eastus', 'tok')
    expect(sizes?.has('Standard_D2as_v7')).toBe(true)
    expect(sizes?.has('Premium_LRS')).toBe(false)
  })

  it('drops restricted SKUs — offered is not the same as usable', async () => {
    mockFetch(() => skus([
      { name: 'Standard_B2s', resourceType: 'virtualMachines', restrictions: [{ reasonCode: 'NotAvailableForSubscription' }] },
      { name: 'Standard_D2as_v7', resourceType: 'virtualMachines', restrictions: [] },
    ]))
    const sizes = await availableSizes('sub', 'eastus', 'tok')
    expect(sizes?.has('Standard_B2s')).toBe(false)
    expect(sizes?.has('Standard_D2as_v7')).toBe(true)
  })

  it('filters by the location asked about', async () => {
    const spy = mockFetch(() => skus([]))
    await availableSizes('sub', 'westus2', 'tok')
    expect(String(spy.mock.calls[0]?.[0])).toContain(encodeURIComponent("location eq 'westus2'"))
  })

  it('is undefined when the call fails, so the check can say so', async () => {
    mockFetch(() => json({ error: 'forbidden' }, 403))
    await expect(availableSizes('sub', 'eastus', 'tok')).resolves.toBeUndefined()
  })
})
