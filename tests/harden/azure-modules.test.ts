// Unit tests for the Azure hardening modules. The pure helpers are exercised directly; the
// check() paths stub ARM through the shared helper so no call leaves the machine.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { RemoteExec } from '../../src/harden/types.js'
import {
  openFindings,
  describePorts,
  worldSources,
} from '../../src/harden/modules/azure-nsg-audit.js'
import { posture, describe as describeGaps } from '../../src/harden/modules/azure-disk-encryption.js'
import { unprotectedPlans } from '../../src/harden/modules/azure-defender.js'
import { coversClawopsVm, resourceName } from '../../src/harden/modules/azure-jit.js'
import { isClawopsResource, explainFailure, armGet } from '../../src/harden/azure-api.js'

const noopExec: RemoteExec = async () => ({ stdout: '', stderr: '', code: 0 })
const CTX = { subscriptionId: 'sub-1', token: 't' }

beforeEach(() => vi.resetModules())

/** Load a module with ARM stubbed to the given responses. */
async function withArm<T>(
  stub: { ctx?: unknown; get?: unknown; vm?: unknown; byId?: unknown; registered?: boolean },
  load: () => Promise<T>,
): Promise<T> {
  vi.doMock('../../src/harden/azure-api.js', async () => {
    const real = await vi.importActual<typeof import('../../src/harden/azure-api.js')>(
      '../../src/harden/azure-api.js',
    )
    return {
      ...real,
      azureContext: async () => stub.ctx,
      armGet: async () => stub.get,
      providerRegistered: async () => stub.registered,
      armGetById: async () => stub.byId,
      findClawopsVm: async () => stub.vm,
    }
  })
  return load()
}

const rule = (props: Record<string, unknown>) => ({ name: 'r', properties: { direction: 'Inbound', access: 'Allow', ...props } })

describe('NSG audit: which rules are findings', () => {
  it('flags SSH open to the whole internet, the rule the audit exists for', () => {
    const found = openFindings([
      { name: 'clawops-nsg-abc', properties: { securityRules: [rule({ sourceAddressPrefix: '0.0.0.0/0', destinationPortRange: '22' })] } },
    ])
    expect(found[0]).toContain('port 22 (SSH)')
  })

  it("treats Azure's `*` source as the internet, which is how the portal writes it", () => {
    const found = openFindings([
      { name: 'clawops-nsg-abc', properties: { securityRules: [rule({ sourceAddressPrefix: '*', destinationPortRange: '22' })] } },
    ])
    expect(found).toHaveLength(1)
  })

  it('treats the Internet service tag as the internet, case-insensitively', () => {
    expect(worldSources(rule({ sourceAddressPrefix: 'Internet' }))).toEqual(['Internet'])
  })

  it('flags IPv6, which admits the internet just as thoroughly', () => {
    const found = openFindings([
      { name: 'clawops-nsg-abc', properties: { securityRules: [rule({ sourceAddressPrefix: '::/0', destinationPortRange: '18789' })] } },
    ])
    expect(found[0]).toContain('::/0')
  })

  it('reads a list of sources, not only a single one', () => {
    expect(worldSources(rule({ sourceAddressPrefixes: ['10.0.0.0/8', '0.0.0.0/0'] }))).toEqual(['0.0.0.0/0'])
  })

  it('names the gateway port rather than leaving a bare number', () => {
    const found = openFindings([
      { name: 'clawops-nsg-abc', properties: { securityRules: [rule({ sourceAddressPrefix: '*', destinationPortRange: '18789' })] } },
    ])
    expect(found[0]).toContain('the OpenClaw gateway')
  })

  it('ignores outbound rules: egress is not this audit and never was', () => {
    expect(openFindings([
      { name: 'clawops-nsg-abc', properties: { securityRules: [{ name: 'out', properties: { direction: 'Outbound', access: 'Allow', sourceAddressPrefix: '*', destinationPortRange: '*' } }] } },
    ])).toEqual([])
  })

  it('ignores Deny rules, which admit nothing', () => {
    expect(openFindings([
      { name: 'clawops-nsg-abc', properties: { securityRules: [{ name: 'd', properties: { direction: 'Inbound', access: 'Deny', sourceAddressPrefix: '*', destinationPortRange: '22' } }] } },
    ])).toEqual([])
  })

  it('ignores a non-clawops NSG in the same subscription', () => {
    expect(openFindings([
      { name: 'default-nsg', properties: { securityRules: [rule({ sourceAddressPrefix: '*', destinationPortRange: '22' })] } },
    ])).toEqual([])
  })

  it('a narrowed source is not a finding', () => {
    expect(openFindings([
      { name: 'clawops-nsg-abc', properties: { securityRules: [rule({ sourceAddressPrefix: '203.0.113.4/32', destinationPortRange: '22' })] } },
    ])).toEqual([])
  })
})

describe('NSG audit: how ports are described', () => {
  it("says every port when Azure's wildcard is used, rather than printing a star", () => {
    expect(describePorts(rule({ destinationPortRange: '*', protocol: '*' }))).toContain('every port')
  })
  it('keeps a range readable', () => {
    expect(describePorts(rule({ destinationPortRange: '8000-9000' }))).toBe('ports 8000-9000')
  })
  it('reads a list of ranges', () => {
    expect(describePorts(rule({ destinationPortRanges: ['22', '443'] }))).toContain('port 443')
  })
})

describe('resource identity is the name, never the id', () => {
  // clawops names its resource group clawops-<stack>, so every id in the group contains
  // "clawops". The GCP audit shipped with exactly this bug against a project called clawops-test.
  it('does not match a foreign resource that merely lives in the clawops resource group', () => {
    expect(isClawopsResource('default-nsg', 'clawops-nsg')).toBe(false)
  })
  it('matches the Pulumi-suffixed name', () => {
    expect(isClawopsResource('clawops-nsg-7cef166', 'clawops-nsg')).toBe(true)
  })
  it('takes the last segment of an ARM id as the name', () => {
    expect(resourceName('/subscriptions/s/resourceGroups/clawops-prod/providers/Microsoft.Compute/virtualMachines/clawops-vm-abc'))
      .toBe('clawops-vm-abc')
  })
})

describe('disk encryption: what is actually variable', () => {
  const vm = (atHost?: boolean) => ({ properties: { securityProfile: { encryptionAtHost: atHost } } })

  it('never claims a managed disk is unencrypted, because Azure always encrypts it', () => {
    expect(posture(vm(false), { properties: { encryption: { type: 'EncryptionAtRestWithPlatformKey' } } }).atRest).toBe(true)
  })

  it('reports encryption at host as the gap the default leaves', () => {
    const gaps = describeGaps(posture(vm(false), { properties: { encryption: { type: 'EncryptionAtRestWithPlatformKey' } } }))
    expect(gaps.join(' ')).toContain('encryption at host is off')
  })

  it('reports a platform key as a gap against a customer-managed one', () => {
    const gaps = describeGaps(posture(vm(true), { properties: { encryption: { type: 'EncryptionAtRestWithPlatformKey' } } }))
    expect(gaps.join(' ')).toContain('platform-managed key')
  })

  it('recognises a customer key, including the combined platform-and-customer type', () => {
    expect(posture(vm(true), { properties: { encryption: { type: 'EncryptionAtRestWithPlatformAndCustomerKeys' } } }).customerKey).toBe(true)
  })

  it('has nothing to report when both are in place', () => {
    expect(describeGaps(posture(vm(true), { properties: { encryption: { type: 'EncryptionAtRestWithCustomerKey' } } }))).toEqual([])
  })

  it('treats a disk it could not read as a platform key rather than inventing one', () => {
    expect(posture(vm(true), undefined).customerKey).toBe(false)
  })
})

describe('Defender: which plans count', () => {
  it('reports a plan left on the free tier', () => {
    expect(unprotectedPlans([{ name: 'VirtualMachines', properties: { pricingTier: 'Free' } }])).toEqual(['VirtualMachines'])
  })
  it('accepts Standard, whatever its case', () => {
    expect(unprotectedPlans([{ name: 'VirtualMachines', properties: { pricingTier: 'standard' } }])).toEqual([])
  })
  it('treats a missing tier as free rather than assuming protection', () => {
    expect(unprotectedPlans([{ name: 'KeyVaults' }])).toEqual(['KeyVaults'])
  })
  it('ignores plans that cover nothing clawops deploys', () => {
    expect(unprotectedPlans([{ name: 'CloudPosture', properties: { pricingTier: 'Free' } }])).toEqual([])
  })
})

describe('JIT: whether a policy covers the clawops VM', () => {
  const policy = (id: string) => ({ name: 'default', properties: { virtualMachines: [{ id }] } })

  it('matches the clawops VM by name', () => {
    expect(coversClawopsVm([policy('/subscriptions/s/resourceGroups/clawops-prod/providers/Microsoft.Compute/virtualMachines/clawops-vm-abc')])).toBe(true)
  })
  it('does not match another VM in the clawops resource group', () => {
    expect(coversClawopsVm([policy('/subscriptions/s/resourceGroups/clawops-prod/providers/Microsoft.Compute/virtualMachines/jumpbox')])).toBe(false)
  })
  it('an empty policy list covers nothing', () => {
    expect(coversClawopsVm([])).toBe(false)
  })
})

describe('check() paths: what each module says when it cannot read', () => {
  it('NSG audit skips without credentials, and says so says nothing about the rules', async () => {
    const r = await withArm({ ctx: undefined }, async () => {
      const { azureNsgAuditModule } = await import('../../src/harden/modules/azure-nsg-audit.js')
      return azureNsgAuditModule.check(noopExec)
    })
    expect(r.status).toBe('skipped')
    expect(r.detail).toContain('says nothing about the rules')
  })

  it('NSG audit reports drift when a clawops rule is open', async () => {
    const r = await withArm(
      { ctx: CTX, get: { ok: true, body: { value: [{ name: 'clawops-nsg-a', properties: { securityRules: [rule({ sourceAddressPrefix: '*', destinationPortRange: '22' })] } }] } } },
      async () => {
        const { azureNsgAuditModule } = await import('../../src/harden/modules/azure-nsg-audit.js')
        return azureNsgAuditModule.check(noopExec)
      },
    )
    expect(r.status).toBe('drifted')
    expect(r.detail).toContain('SSH')
  })

  it('disk encryption skips when no clawops VM is deployed', async () => {
    const r = await withArm({ ctx: CTX, vm: undefined }, async () => {
      const { azureDiskEncryptionModule } = await import('../../src/harden/modules/azure-disk-encryption.js')
      return azureDiskEncryptionModule.check(noopExec)
    })
    expect(r.status).toBe('skipped')
  })

  it('JIT explains that the read may fail because the paid plan is absent', async () => {
    const r = await withArm({ ctx: CTX, vm: { name: 'clawops-vm-a' }, registered: true, get: { ok: false, reason: 'forbidden' } }, async () => {
      const { azureJitModule } = await import('../../src/harden/modules/azure-jit.js')
      return azureJitModule.check(noopExec)
    })
    expect(r.status).toBe('skipped')
    expect(r.detail).toContain('Defender for Servers Plan 2')
  })
})

/*
 * Both of these come from running the checks against a live subscription. Microsoft.Security was
 * unregistered there, and neither failure mode was reachable from a hand-written fixture.
 */
describe('armGet classifies the failure, which is where the distinction is made', () => {
  const withFetch = async <T>(status: number, body: string, run: () => Promise<T>): Promise<T> => {
    const original = globalThis.fetch
    globalThis.fetch = (async () =>
      ({ ok: status >= 200 && status < 300, status, text: async () => body, json: async () => ({}) }) as unknown as Response) as typeof fetch
    try {
      return await run()
    } finally {
      globalThis.fetch = original
    }
  }

  // ARM answers an unregistered namespace with 404 and this body. Live, Microsoft.Security was
  // unregistered and `pricings` returned exactly this.
  it('reads a 404 naming registration as unregistered, and takes the namespace from the path', async () => {
    const r = await withFetch(404, '{"error":{"code":"Subscription Not Registered","message":"Please register to Microsoft.Security in order to view your security status"}}',
      () => armGet(CTX, '/providers/Microsoft.Security/pricings?api-version=2023-01-01'))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('unregistered')
      if (r.reason === 'unregistered') expect(r.namespace).toBe('Microsoft.Security')
    }
  })

  it('a 404 that is merely absent stays a plain error, not advice to register something', async () => {
    const r = await withFetch(404, '{"error":{"code":"ResourceNotFound","message":"not found"}}',
      () => armGet(CTX, '/providers/Microsoft.Compute/virtualMachines/x?api-version=2023-09-01'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('error')
  })

  it('a 403 is forbidden, which is the case that really is a permission', async () => {
    const r = await withFetch(403, '{}', () => armGet(CTX, '/providers/Microsoft.Security/pricings?api-version=2023-01-01'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('forbidden')
  })
})

describe('a failed read says why, because the fixes are different', () => {
  it('names the provider to register rather than blaming permissions', () => {
    const d = explainFailure({ reason: 'unregistered', namespace: 'Microsoft.Security' }, 'Defender pricing', 'x/read')
    expect(d).toContain('az provider register --namespace Microsoft.Security')
    expect(d).not.toContain('not allowed')
  })

  it('says registering costs nothing, so the advice is safe to follow', () => {
    expect(explainFailure({ reason: 'unregistered', namespace: 'Microsoft.Security' }, 's', 'p'))
      .toContain('costs nothing')
  })

  it('blames permissions only when ARM actually said 403', () => {
    const d = explainFailure({ reason: 'forbidden' }, 'Defender pricing', 'Microsoft.Security/pricings/read')
    expect(d).toContain('Microsoft.Security/pricings/read')
    expect(d).not.toContain('az provider register')
  })
})

describe('JIT does not read an empty list as a definite negative', () => {
  // With Microsoft.Security unregistered, jitNetworkAccessPolicies answers 200 with an empty
  // list while pricings answers 404. "No policy covers the VM" would be a fact about a
  // subscription that cannot have JIT at all.
  it('skips when the namespace is unregistered, even though the list read succeeds', async () => {
    const r = await withArm(
      { ctx: CTX, vm: { name: 'clawops-vm-a' }, registered: false, get: { ok: true, body: { value: [] } } },
      async () => {
        const { azureJitModule } = await import('../../src/harden/modules/azure-jit.js')
        return azureJitModule.check(noopExec)
      },
    )
    expect(r.status).toBe('skipped')
    expect(r.detail).toContain('az provider register')
  })

  it('still reports a real absence when the provider is registered', async () => {
    const r = await withArm(
      { ctx: CTX, vm: { name: 'clawops-vm-a' }, registered: true, get: { ok: true, body: { value: [] } } },
      async () => {
        const { azureJitModule } = await import('../../src/harden/modules/azure-jit.js')
        return azureJitModule.check(noopExec)
      },
    )
    expect(r.status).toBe('missing')
  })
})

describe('apply() is a no-op on every Azure module, and says why', () => {
  it('Defender names the recurring cost rather than enabling it', async () => {
    const { azureDefenderModule } = await import('../../src/harden/modules/azure-defender.js')
    const r = await azureDefenderModule.apply(noopExec)
    expect(r.changed).toBe(false)
    expect(r.detail).toContain('billed per resource per month')
  })
  it('JIT warns that it takes the NSG rules over from the plan', async () => {
    const { azureJitModule } = await import('../../src/harden/modules/azure-jit.js')
    expect((await azureJitModule.apply(noopExec)).detail).toContain('drifted')
  })
  it('disk encryption explains it cannot run against a live VM', async () => {
    const { azureDiskEncryptionModule } = await import('../../src/harden/modules/azure-disk-encryption.js')
    expect((await azureDiskEncryptionModule.apply(noopExec)).detail).toContain('while the VM is running')
  })
})
