// Unit tests for the GCP hardening modules. The pure helpers are exercised directly; the
// check() paths stub the Compute API through the shared helper so no call leaves the machine.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { RemoteExec } from '../../src/harden/types.js'
import { describePorts, openFindings, networkName } from '../../src/harden/modules/gcp-firewall-audit.js'
import { missingProtections } from '../../src/harden/modules/gcp-shielded-vm.js'
import { osLoginEnabled } from '../../src/harden/modules/gcp-os-login.js'
import { isClawopsInstance } from '../../src/harden/gcp-api.js'

const noopExec: RemoteExec = async () => ({ stdout: '', stderr: '', code: 0 })
const CTX = { project: 'proj', token: 't' }

beforeEach(() => vi.resetModules())

/** Load a module with the Compute API stubbed to the given responses. */
async function withApi<T>(
  stub: { ctx?: unknown; get?: unknown; instance?: unknown },
  load: () => Promise<T>,
): Promise<T> {
  vi.doMock('../../src/harden/gcp-api.js', () => ({
    gcpContext: async () => stub.ctx,
    computeGet: async () => stub.get,
    findClawopsInstance: async () => stub.instance,
    metadataValue: (inst: { metadata?: { items?: Array<{ key?: string; value?: string }> } }, k: string) =>
      inst.metadata?.items?.find((i) => i.key === k)?.value,
  }))
  return load()
}

describe('firewall audit: which rules are findings', () => {
  it('flags SSH open to the whole internet, the rule the audit exists for', () => {
    expect(openFindings([{
      name: 'clawops-firewall-ssh', network: 'projects/p/global/networks/clawops-network',
      sourceRanges: ['0.0.0.0/0'], allowed: [{ IPProtocol: 'tcp', ports: ['22'] }],
    }])[0]).toContain('port 22 (SSH)')
  })

  it('flags IPv6, which admits the internet just as thoroughly', () => {
    expect(openFindings([{
      name: 'r', network: 'clawops-network', sourceRanges: ['::/0'],
      allowed: [{ IPProtocol: 'tcp', ports: ['18789'] }],
    }])[0]).toContain('::/0')
  })

  it('names the gateway port, so the finding says what is exposed', () => {
    expect(openFindings([{
      name: 'r', network: 'clawops-network', sourceRanges: ['0.0.0.0/0'],
      allowed: [{ IPProtocol: 'tcp', ports: ['18789'] }],
    }])[0]).toContain('the OpenClaw gateway')
  })

  it('passes a rule narrowed to one address', () => {
    expect(openFindings([{
      name: 'r', network: 'clawops-network', sourceRanges: ['203.0.113.4/32'],
      allowed: [{ IPProtocol: 'tcp', ports: ['22'] }],
    }])).toEqual([])
  })

  it('ignores a disabled rule and an egress rule', () => {
    expect(openFindings([
      { name: 'off', network: 'clawops-network', disabled: true, sourceRanges: ['0.0.0.0/0'], allowed: [] },
      { name: 'out', network: 'clawops-network', direction: 'EGRESS', sourceRanges: ['0.0.0.0/0'], allowed: [] },
    ])).toEqual([])
  })

  // Found by running the module against a real project. The self-link contains the project
  // name, so a substring match on "clawops" flagged every default-network rule in a project
  // called clawops-test. 29 unit tests passed because their fixtures used a project named "p".
  it('does not mistake the project name for the network name', () => {
    const real = 'https://www.googleapis.com/compute/v1/projects/clawops-test/global/networks/default'
    expect(networkName(real)).toBe('default')
    expect(openFindings([{
      name: 'default-allow-ssh', network: real,
      sourceRanges: ['0.0.0.0/0'], allowed: [{ IPProtocol: 'tcp', ports: ['22'] }],
    }])).toEqual([])
  })

  it('still finds the rule on the network clawops made, suffix and all', () => {
    const ours = 'https://www.googleapis.com/compute/v1/projects/clawops-test/global/networks/clawops-network-a1b2c3'
    expect(openFindings([{
      name: 'clawops-firewall-ssh', network: ours,
      sourceRanges: ['0.0.0.0/0'], allowed: [{ IPProtocol: 'tcp', ports: ['22'] }],
    }])).toHaveLength(1)
  })

  it('ignores networks that are not this deployment', () => {
    expect(openFindings([{
      name: 'other', network: 'projects/p/global/networks/default',
      sourceRanges: ['0.0.0.0/0'], allowed: [{ IPProtocol: 'tcp', ports: ['22'] }],
    }])).toEqual([])
  })

  it('treats an absent port list as every port, which is what GCP means by it', () => {
    expect(describePorts([{ IPProtocol: 'tcp' }])).toBe('all tcp ports')
  })
})

describe('firewall audit: what it reports', () => {
  it('skips, rather than passing, when the rules cannot be read', async () => {
    const r = await withApi({ ctx: CTX, get: undefined }, async () => {
      const { gcpFirewallAuditModule } = await import('../../src/harden/modules/gcp-firewall-audit.js')
      return gcpFirewallAuditModule.check(noopExec)
    })
    expect(r.status).toBe('skipped')
    expect(r.detail).toContain('compute.firewalls.list')
  })

  it('skips when no credentials resolve, and says the rules are not implicated', async () => {
    const r = await withApi({ ctx: undefined }, async () => {
      const { gcpFirewallAuditModule } = await import('../../src/harden/modules/gcp-firewall-audit.js')
      return gcpFirewallAuditModule.check(noopExec)
    })
    expect(r.status).toBe('skipped')
    expect(r.detail).toContain('says nothing about the rules')
  })

  it('reports drift when a rule is open', async () => {
    const r = await withApi({
      ctx: CTX,
      get: { items: [{ name: 'clawops-firewall-ssh', network: 'clawops-network',
                       sourceRanges: ['0.0.0.0/0'], allowed: [{ IPProtocol: 'tcp', ports: ['22'] }] }] },
    }, async () => {
      const { gcpFirewallAuditModule } = await import('../../src/harden/modules/gcp-firewall-audit.js')
      return gcpFirewallAuditModule.check(noopExec)
    })
    expect(r.status).toBe('drifted')
  })

  it('does not pretend to fix anything', async () => {
    const { gcpFirewallAuditModule } = await import('../../src/harden/modules/gcp-firewall-audit.js')
    const r = await gcpFirewallAuditModule.apply(noopExec)
    expect(r.changed).toBe(false)
    expect(r.detail).toContain('--ssh-cidr')
  })
})

describe('shielded VM', () => {
  it('names each protection that is off', () => {
    expect(missingProtections({ secureBoot: false, vtpm: true, integrityMonitoring: false }))
      .toEqual(['Secure Boot', 'integrity monitoring'])
  })

  it('is satisfied only when all three are on', () => {
    expect(missingProtections({ secureBoot: true, vtpm: true, integrityMonitoring: true })).toEqual([])
  })

  it('reports missing protections without claiming it can fix them', async () => {
    const r = await withApi({ ctx: CTX, instance: { name: 'clawops-instance', shieldedInstanceConfig: {} } },
      async () => {
        const { gcpShieldedVmModule } = await import('../../src/harden/modules/gcp-shielded-vm.js')
        return gcpShieldedVmModule.check(noopExec)
      })
    expect(r.status).toBe('missing')
    expect(r.detail).toContain('requires stopping the instance')
  })

  it('refuses to apply, because the gateway would have to go down', async () => {
    const { gcpShieldedVmModule } = await import('../../src/harden/modules/gcp-shielded-vm.js')
    const r = await gcpShieldedVmModule.apply(noopExec)
    expect(r.changed).toBe(false)
    expect(r.detail).toContain('cannot be changed on a running instance')
  })
})

describe('OS Login', () => {
  it.each(['TRUE', 'true', '1', 'yes'])('reads %s as enabled', (v) => {
    expect(osLoginEnabled(v)).toBe(true)
  })

  it.each([undefined, '', 'FALSE', 'off', '0'])('reads %s as not enabled', (v) => {
    expect(osLoginEnabled(v)).toBe(false)
  })

  it('treats OS Login being ON as drift, because clawops loses access', async () => {
    const r = await withApi({
      ctx: CTX,
      instance: { name: 'clawops-instance', metadata: { items: [{ key: 'enable-oslogin', value: 'TRUE' }] } },
    }, async () => {
      const { gcpOsLoginModule } = await import('../../src/harden/modules/gcp-os-login.js')
      return gcpOsLoginModule.check(noopExec)
    })
    expect(r.status).toBe('drifted')
    expect(r.detail).toContain('ignores metadata SSH keys')
  })

  it('treats OS Login being OFF as the state clawops needs', async () => {
    const r = await withApi({ ctx: CTX, instance: { name: 'clawops-instance', metadata: { items: [] } } },
      async () => {
        const { gcpOsLoginModule } = await import('../../src/harden/modules/gcp-os-login.js')
        return gcpOsLoginModule.check(noopExec)
      })
    expect(r.status).toBe('applied')
  })

  it('never enables it, and says why', async () => {
    const { gcpOsLoginModule } = await import('../../src/harden/modules/gcp-os-login.js')
    const r = await gcpOsLoginModule.apply(noopExec)
    expect(r.changed).toBe(false)
    expect(r.detail).toContain('every day-two command would fail')
  })

  it('is off by default, since it reports a posture clawops cannot adopt', async () => {
    const { gcpOsLoginModule } = await import('../../src/harden/modules/gcp-os-login.js')
    expect(gcpOsLoginModule.defaultOn).toBe(false)
  })
})

describe('the catalog', () => {
  it('carries the three GCP modules, scoped to gcp only', async () => {
    const { MODULE_CATALOG } = await import('../../src/harden/index.js')
    const gcp = MODULE_CATALOG.filter((m) => m.id.startsWith('gcp-'))
    expect(gcp.map((m) => m.id).sort())
      .toEqual(['gcp-firewall-audit', 'gcp-os-login', 'gcp-shielded-vm'])
    for (const m of gcp) expect(m.providers).toEqual(['gcp'])
  })
})

// Both of these were found by running against a real deployment, not by reading the code.
// Pulumi auto-names its resources, so neither the network nor the instance carries the bare
// logical name the modules were written to look for.
describe('names as they exist after a deploy, not as written in the program', () => {
  it('recognises the instance Pulumi actually created', () => {
    expect(isClawopsInstance('clawops-instance-7f3a9c1')).toBe(true)
    expect(isClawopsInstance('clawops-instance')).toBe(true)
  })

  it('does not claim someone else\'s instance', () => {
    expect(isClawopsInstance('build-runner-3')).toBe(false)
    expect(isClawopsInstance(undefined)).toBe(false)
  })
})
