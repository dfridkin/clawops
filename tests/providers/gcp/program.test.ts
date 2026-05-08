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

describe('gcpProgram — happy path', () => {
  it('returns all BaseStackOutputs keys', async () => {
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

  it('creates all expected resources', async () => {
    await runProgram()

    const types = created.map(r => r.type)
    expect(types).toContain('gcp:compute/network:Network')
    expect(types).toContain('gcp:compute/subnetwork:Subnetwork')
    expect(types).toContain('gcp:compute/firewall:Firewall')
    expect(types).toContain('gcp:compute/address:Address')
    expect(types).toContain('gcp:compute/instance:Instance')
  })
})

describe('gcpProgram — firewall', () => {
  it('always opens 0.0.0.0/0 (no accessMode support on GCP)', async () => {
    await runProgram()

    const fw = created.find(r => r.type === 'gcp:compute/firewall:Firewall')
    expect(fw).toBeDefined()
    expect(fw!.inputs['sourceRanges']).toEqual(['0.0.0.0/0'])
  })

  it('allows both SSH (22) and gateway (18789) ports', async () => {
    await runProgram()

    const fw = created.find(r => r.type === 'gcp:compute/firewall:Firewall')
    const allows = fw!.inputs['allows'] as Array<{ protocol: string; ports: string[] }>
    expect(allows).toHaveLength(1)
    expect(allows[0]!.ports).toContain('22')
    expect(allows[0]!.ports).toContain('18789')
  })

  it('targets the clawops network tag', async () => {
    await runProgram()

    const fw = created.find(r => r.type === 'gcp:compute/firewall:Firewall')
    expect(fw!.inputs['targetTags']).toContain('clawops')
  })
})

describe('gcpProgram — instance config', () => {
  it('uses default instanceType e2-standard-2 when not configured', async () => {
    await runProgram()

    const vm = created.find(r => r.type === 'gcp:compute/instance:Instance')
    expect(vm!.inputs['machineType']).toBe('e2-standard-2')
  })

  it('uses configured instanceType', async () => {
    setConfig({ instanceType: 'e2-standard-4' })

    await runProgram()

    const vm = created.find(r => r.type === 'gcp:compute/instance:Instance')
    expect(vm!.inputs['machineType']).toBe('e2-standard-4')
  })

  it('defaults zone to <region>-a', async () => {
    setConfig({ region: 'europe-west1' })

    await runProgram()

    const vm = created.find(r => r.type === 'gcp:compute/instance:Instance')
    expect(vm!.inputs['zone']).toBe('europe-west1-a')
  })

  it('uses explicit zone when configured', async () => {
    setConfig({ region: 'us-central1', zone: 'us-central1-b' })

    await runProgram()

    const vm = created.find(r => r.type === 'gcp:compute/instance:Instance')
    expect(vm!.inputs['zone']).toBe('us-central1-b')
  })

  it('applies clawops network tag to instance', async () => {
    await runProgram()

    const vm = created.find(r => r.type === 'gcp:compute/instance:Instance')
    expect(vm!.inputs['tags']).toContain('clawops')
  })

  it('uses Debian 12 boot disk image', async () => {
    await runProgram()

    const vm = created.find(r => r.type === 'gcp:compute/instance:Instance')
    const bootDisk = vm!.inputs['bootDisk'] as { initializeParams: { image: string } }
    expect(bootDisk.initializeParams.image).toBe('debian-cloud/debian-12')
  })
})

describe('gcpProgram — static IP', () => {
  it('creates a static external address', async () => {
    await runProgram()

    const addr = created.find(r => r.type === 'gcp:compute/address:Address')
    expect(addr).toBeDefined()
  })

  it('uses default region us-central1', async () => {
    await runProgram()

    const result = await runProgram()
    expect(result).toHaveProperty('region', 'us-central1')
  })
})
