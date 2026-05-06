// Azure Pulumi program unit tests.
// Uses vi.mock to stub @pulumi/azure-native and @pulumi/pulumi — no gRPC, no engine.
// Tests the program logic (NSG rules, Key Vault, outputs) in isolation.

import { describe, it, expect, beforeEach, vi } from 'vitest'

// ─── Pulumi mock ──────────────────────────────────────────────────────────────

type ResourceEntry = { type: string; name: string; inputs: Record<string, unknown> }
const created: ResourceEntry[] = []

const configValues: Record<string, string> = {}
let mockStackName = 'test-stack'

function mockConfig() {
  return {
    get: (key: string) => configValues[key],
  }
}

vi.mock('@pulumi/pulumi', () => {
  const pulumi = {
    Config: vi.fn(() => mockConfig()),
    getStack: vi.fn(() => mockStackName),
    output: (val: unknown) => ({
      apply: (fn: (v: unknown) => unknown) => fn(val),
    }),
    interpolate: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.raw.reduce((acc, part, i) => acc + part + (values[i] ?? ''), ''),
  }
  return pulumi
})

vi.mock('@pulumi/azure-native', async () => {
  function makeConstructor(type: string) {
    return class {
      id: string
      name: string
      location: string
      constructor(name: string, inputs: Record<string, unknown> = {}) {
        this.id = `${name}-id`
        this.name = (inputs['vaultName'] as string) ?? name
        this.location = (inputs['location'] as string) ?? 'eastus'
        Object.assign(this, inputs)
        created.push({ type, name, inputs })
      }
    }
  }

  const resources = { ResourceGroup: makeConstructor('azure-native:resources:ResourceGroup') }
  const network = {
    VirtualNetwork: makeConstructor('azure-native:network:VirtualNetwork'),
    Subnet: makeConstructor('azure-native:network:Subnet'),
    NetworkSecurityGroup: makeConstructor('azure-native:network:NetworkSecurityGroup'),
    PublicIPAddress: (() => {
      const Ctor = makeConstructor('azure-native:network:PublicIPAddress')
      return class extends Ctor {
        ipAddress = '5.6.7.8'
      }
    })(),
    NetworkInterface: makeConstructor('azure-native:network:NetworkInterface'),
  }
  const compute = {
    VirtualMachine: (() => {
      const Ctor = makeConstructor('azure-native:compute:VirtualMachine')
      return class extends Ctor {
        identity = { principalId: 'mock-principal', tenantId: 'mock-tenant', type: 'SystemAssigned' }
      }
    })(),
  }
  const keyvault = {
    Vault: makeConstructor('azure-native:keyvault:Vault'),
    Secret: makeConstructor('azure-native:keyvault:Secret'),
  }
  const authorization = {
    RoleAssignment: makeConstructor('azure-native:authorization:RoleAssignment'),
  }

  return { resources, network, compute, keyvault, authorization }
})

// ─── Tests ────────────────────────────────────────────────────────────────────

function setConfig(values: Record<string, string>) {
  Object.keys(configValues).forEach(k => delete configValues[k])
  Object.assign(configValues, values)
}

beforeEach(() => {
  created.length = 0
  Object.keys(configValues).forEach(k => delete configValues[k])
  mockStackName = 'test-stack'
  vi.resetModules()
})

async function runProgram() {
  const { azureProgram } = await import('../../../src/providers/azure/program.js')
  return azureProgram()
}

describe('azureProgram — happy path', () => {
  it('runs without throwing and returns all BaseStackOutputs keys', async () => {
    setConfig({ sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAATEST test' })

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
})

describe('azureProgram — accessMode=restricted (default)', () => {
  it('creates no security rules when allowedCidrs is empty', async () => {
    setConfig({ sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAATEST test' })

    await runProgram()

    const nsg = created.find(r => r.type === 'azure-native:network:NetworkSecurityGroup')
    expect(nsg).toBeDefined()
    expect((nsg!.inputs['securityRules'] as unknown[]) ?? []).toHaveLength(0)
  })

  it('creates 2 security rules when 1 allowedCidr is set (1 CIDR × 2 ports)', async () => {
    setConfig({
      sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAATEST test',
      accessMode: 'restricted',
      allowedCidrs: '10.0.0.1/32',
    })

    await runProgram()

    const nsg = created.find(r => r.type === 'azure-native:network:NetworkSecurityGroup')
    const rules = (nsg!.inputs['securityRules'] as unknown[]) ?? []
    expect(rules).toHaveLength(2)
  })
})

describe('azureProgram — accessMode=auto', () => {
  it('uses detected egress IP as /32 for security rules', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('203.0.113.99\n', { status: 200 }),
    )

    setConfig({
      sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAATEST test',
      accessMode: 'auto',
    })

    await runProgram()

    const nsg = created.find(r => r.type === 'azure-native:network:NetworkSecurityGroup')
    const rules = nsg!.inputs['securityRules'] as Array<{ sourceAddressPrefix: string }>
    expect(rules).toHaveLength(2)
    expect(rules.every(r => r.sourceAddressPrefix === '203.0.113.99/32')).toBe(true)
  })
})

describe('azureProgram — accessMode=open', () => {
  it('uses 0.0.0.0/0 and emits a warning', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    setConfig({
      sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAATEST test',
      accessMode: 'open',
    })

    await runProgram()

    const nsg = created.find(r => r.type === 'azure-native:network:NetworkSecurityGroup')
    const rules = nsg!.inputs['securityRules'] as Array<{ sourceAddressPrefix: string }>
    expect(rules.every(r => r.sourceAddressPrefix === '0.0.0.0/0')).toBe(true)
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('accessMode=open'))
  })
})

describe('azureProgram — Key Vault (keyVaultEnabled)', () => {
  it('does NOT create Key Vault resources by default', async () => {
    setConfig({ sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAATEST test' })

    await runProgram()

    const kv = created.find(r => r.type === 'azure-native:keyvault:Vault')
    expect(kv).toBeUndefined()
  })

  it('creates Key Vault, RoleAssignment, and Secret when keyVaultEnabled=true', async () => {
    setConfig({
      sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAATEST test',
      keyVaultEnabled: 'true',
    })

    await runProgram()

    expect(created.find(r => r.type === 'azure-native:keyvault:Vault')).toBeDefined()
    expect(created.find(r => r.type === 'azure-native:authorization:RoleAssignment')).toBeDefined()
    expect(created.find(r => r.type === 'azure-native:keyvault:Secret')).toBeDefined()
  })

  it('truncates Key Vault name to 24 chars', async () => {
    mockStackName = 'very-long-stack-name-that-exceeds'
    setConfig({
      sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAATEST test',
      keyVaultEnabled: 'true',
    })

    await runProgram()

    const kv = created.find(r => r.type === 'azure-native:keyvault:Vault')
    const kvName = kv?.inputs['vaultName'] as string
    expect(kvName.length).toBeLessThanOrEqual(24)
  })
})

describe('azureProgram — sshPublicKey validation', () => {
  it('throws a clear error when sshPublicKey is missing', async () => {
    // No sshPublicKey set
    await expect(runProgram()).rejects.toThrow('sshPublicKey')
  })
})
