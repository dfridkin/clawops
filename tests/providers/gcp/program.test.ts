// GCP Pulumi program unit tests.
// Uses vi.mock to stub @pulumi/gcp and @pulumi/pulumi — no gRPC, no engine.

import { describe, it, expect, beforeEach, vi } from 'vitest'

// ─── Pulumi mock ──────────────────────────────────────────────────────────────

type ResourceEntry = { type: string; name: string; inputs: Record<string, unknown> }
const created: ResourceEntry[] = []

const configValues: Record<string, string> = {}

function mockConfig() {
  return {
    get: (key: string) => configValues[key],
  }
}

vi.mock('@pulumi/pulumi', () => {
  class MockResource {
    id: string
    selfLink: string
    address: string
    name: string
    constructor(name: string, inputs: Record<string, unknown> = {}) {
      this.name = name
      this.id = `${name}-id`
      this.selfLink = `${name}-selfLink`
      this.address = `${name}-address`
      Object.assign(this, inputs)
    }
  }

  const pulumi = {
    Config: vi.fn(() => mockConfig()),
    getStack: vi.fn(() => 'test-stack'),
    interpolate: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.raw.reduce((acc, part, i) => acc + part + (values[i] ?? ''), ''),
    ComponentResource: MockResource,
  }
  return pulumi
})

vi.mock('@pulumi/gcp', async () => {
  function makeConstructor(type: string) {
    return class {
      id: string
      selfLink: string
      address: string
      constructor(name: string, inputs: Record<string, unknown> = {}) {
        this.id = `${name}-id`
        this.selfLink = `${name}-selfLink`
        this.address = `${name}-address`
        Object.assign(this, inputs)
        created.push({ type, name, inputs })
      }
    }
  }

  const compute = {
    Network: makeConstructor('gcp:compute/network:Network'),
    Subnetwork: makeConstructor('gcp:compute/subnetwork:Subnetwork'),
    Firewall: makeConstructor('gcp:compute/firewall:Firewall'),
    Address: makeConstructor('gcp:compute/address:Address'),
    Instance: makeConstructor('gcp:compute/instance:Instance'),
  }

  return { compute }
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setConfig(values: Record<string, string>) {
  Object.keys(configValues).forEach(k => delete configValues[k])
  Object.assign(configValues, values)
}

const BASE_CONFIG = { sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAATEST test' }

beforeEach(() => {
  created.length = 0
  Object.keys(configValues).forEach(k => delete configValues[k])
  vi.resetModules()
})

async function runProgram() {
  const { gcpProgram } = await import('../../../src/providers/gcp/program.js')
  return gcpProgram()
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('gcpProgram — sshPublicKey validation', () => {
  it('throws a clear error when sshPublicKey is missing', async () => {
    // No sshPublicKey set
    await expect(runProgram()).rejects.toThrow('sshPublicKey')
  })
})

describe('gcpProgram — happy path', () => {
  it('returns all BaseStackOutputs keys', async () => {
    setConfig(BASE_CONFIG)
    const result = await runProgram()

    expect(result).toHaveProperty('instanceId')
    expect(result).toHaveProperty('publicIp')
    expect(result).toHaveProperty('gatewayUrl')
    expect(result).toHaveProperty('sshHost')
    expect(result).toHaveProperty('sshPort', 22)
    expect(result).toHaveProperty('sshUser', 'clawops')
    expect(result).toHaveProperty('region')
    expect(result).toHaveProperty('provisionedAt')
  })

  it('creates network, subnet, static IP, and instance', async () => {
    setConfig(BASE_CONFIG)
    await runProgram()

    const types = created.map(r => r.type)
    expect(types).toContain('gcp:compute/network:Network')
    expect(types).toContain('gcp:compute/subnetwork:Subnetwork')
    expect(types).toContain('gcp:compute/address:Address')
    expect(types).toContain('gcp:compute/instance:Instance')
  })
})

describe('gcpProgram — SSH key injection', () => {
  it('adds ssh-keys metadata so the guest agent populates authorized_keys', async () => {
    setConfig(BASE_CONFIG)
    await runProgram()

    const vm = created.find(r => r.type === 'gcp:compute/instance:Instance')
    const meta = vm!.inputs['metadata'] as Record<string, string>
    expect(meta['ssh-keys']).toBe('clawops:ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAATEST test')
  })

  it('includes startup-script in metadata alongside ssh-keys', async () => {
    setConfig(BASE_CONFIG)
    await runProgram()

    const vm = created.find(r => r.type === 'gcp:compute/instance:Instance')
    const meta = vm!.inputs['metadata'] as Record<string, string>
    expect(meta['startup-script']).toContain('#!/bin/bash')
  })
})

describe('gcpProgram — firewall / accessMode=restricted (default)', () => {
  it('creates NO firewall rules when no CIDRs are configured', async () => {
    setConfig(BASE_CONFIG)
    await runProgram()

    const firewalls = created.filter(r => r.type === 'gcp:compute/firewall:Firewall')
    expect(firewalls).toHaveLength(0)
  })

  it('creates separate SSH and gateway firewall rules when allowedCidrs is set', async () => {
    setConfig({ ...BASE_CONFIG, accessMode: 'restricted', allowedCidrs: '10.0.0.1/32' })
    await runProgram()

    const firewalls = created.filter(r => r.type === 'gcp:compute/firewall:Firewall')
    expect(firewalls).toHaveLength(2)
    const sshFw = firewalls.find(r => r.name.includes('ssh'))
    const gwFw  = firewalls.find(r => r.name.includes('gateway'))
    expect(sshFw).toBeDefined()
    expect(gwFw).toBeDefined()
  })
})

describe('gcpProgram — firewall / accessMode=auto', () => {
  it('uses detected egress IP as /32 for both rules', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('203.0.113.42\n', { status: 200 }),
    )
    setConfig({ ...BASE_CONFIG, accessMode: 'auto' })
    await runProgram()

    const firewalls = created.filter(r => r.type === 'gcp:compute/firewall:Firewall')
    expect(firewalls).toHaveLength(2)
    for (const fw of firewalls) {
      expect(fw.inputs['sourceRanges']).toEqual(['203.0.113.42/32'])
    }
  })

  it('throws when egress IP detection fails — never silently locks out', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('timeout'))
    setConfig({ ...BASE_CONFIG, accessMode: 'auto' })
    await expect(runProgram()).rejects.toThrow(/egress IP detection failed/)
  })
})

describe('gcpProgram — firewall / accessMode=open', () => {
  it('uses 0.0.0.0/0 and emits a warning', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    setConfig({ ...BASE_CONFIG, accessMode: 'open' })
    await runProgram()

    const firewalls = created.filter(r => r.type === 'gcp:compute/firewall:Firewall')
    expect(firewalls).toHaveLength(2)
    for (const fw of firewalls) {
      expect(fw.inputs['sourceRanges']).toEqual(['0.0.0.0/0'])
    }
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('accessMode=open'))
  })
})

describe('gcpProgram — per-port CIDR override', () => {
  it('sshCidrs overrides accessMode for SSH only', async () => {
    setConfig({ ...BASE_CONFIG, accessMode: 'restricted', sshCidrs: '192.168.1.0/24' })
    await runProgram()

    const firewalls = created.filter(r => r.type === 'gcp:compute/firewall:Firewall')
    // Only SSH firewall is created (gateway has no CIDRs from restricted default)
    expect(firewalls).toHaveLength(1)
    const sshFw = firewalls[0]!
    expect(sshFw.inputs['sourceRanges']).toEqual(['192.168.1.0/24'])
    const allows = sshFw.inputs['allows'] as Array<{ ports: string[] }>
    expect(allows[0]!.ports).toEqual(['22'])
  })
})

describe('gcpProgram — instance config', () => {
  it('uses default instanceType e2-standard-2 when not configured', async () => {
    setConfig(BASE_CONFIG)
    await runProgram()

    const vm = created.find(r => r.type === 'gcp:compute/instance:Instance')
    expect(vm!.inputs['machineType']).toBe('e2-standard-2')
  })

  it('uses configured instanceType', async () => {
    setConfig({ ...BASE_CONFIG, instanceType: 'e2-standard-4' })
    await runProgram()

    const vm = created.find(r => r.type === 'gcp:compute/instance:Instance')
    expect(vm!.inputs['machineType']).toBe('e2-standard-4')
  })

  it('defaults zone to <region>-a', async () => {
    setConfig({ ...BASE_CONFIG, region: 'europe-west1' })
    await runProgram()

    const vm = created.find(r => r.type === 'gcp:compute/instance:Instance')
    expect(vm!.inputs['zone']).toBe('europe-west1-a')
  })

  it('uses explicit zone when configured', async () => {
    setConfig({ ...BASE_CONFIG, region: 'us-central1', zone: 'us-central1-b' })
    await runProgram()

    const vm = created.find(r => r.type === 'gcp:compute/instance:Instance')
    expect(vm!.inputs['zone']).toBe('us-central1-b')
  })

  it('applies clawops network tag to instance', async () => {
    setConfig(BASE_CONFIG)
    await runProgram()

    const vm = created.find(r => r.type === 'gcp:compute/instance:Instance')
    expect(vm!.inputs['tags']).toContain('clawops')
  })

  it('uses Debian 12 boot disk image', async () => {
    setConfig(BASE_CONFIG)
    await runProgram()

    const vm = created.find(r => r.type === 'gcp:compute/instance:Instance')
    const bootDisk = vm!.inputs['bootDisk'] as { initializeParams: { image: string } }
    expect(bootDisk.initializeParams.image).toBe('debian-cloud/debian-12')
  })
})

describe('gcpProgram — static IP', () => {
  it('creates a static external address', async () => {
    setConfig(BASE_CONFIG)
    await runProgram()

    const addr = created.find(r => r.type === 'gcp:compute/address:Address')
    expect(addr).toBeDefined()
  })

  it('uses default region us-central1', async () => {
    setConfig(BASE_CONFIG)
    const result = await runProgram()
    expect(result).toHaveProperty('region', 'us-central1')
  })
})
