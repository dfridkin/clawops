// AWS Pulumi program unit tests.
// Uses vi.mock to stub @pulumi/aws and @pulumi/pulumi — no gRPC, no engine.
// Tests the program logic (firewall rules, IAM policies, outputs) in isolation.

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
    name: string
    constructor(name: string, inputs: Record<string, unknown> = {}) {
      this.name = name
      this.id = `${name}-id`
      Object.assign(this, inputs)
      // Registration done in subclasses via type
    }
  }

  const pulumi = {
    Config: vi.fn(() => mockConfig()),
    getStack: vi.fn(() => 'test-stack'),
    output: (val: unknown) => ({
      apply: (fn: (v: unknown) => unknown) => fn(
        typeof val === 'object' && val !== null && 'principalId' in val
          ? val
          : val,
      ),
    }),
    interpolate: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.raw.reduce((acc, part, i) => acc + part + (values[i] ?? ''), ''),
    ComponentResource: MockResource,
  }
  return pulumi
})

vi.mock('@pulumi/aws', async () => {
  function makeConstructor(type: string) {
    return class {
      id: string
      constructor(name: string, inputs: Record<string, unknown> = {}) {
        this.id = `${name}-id`
        Object.assign(this, inputs)
        created.push({ type, name, inputs })
      }
    }
  }

  const ec2 = {
    Vpc: makeConstructor('aws:ec2/vpc:Vpc'),
    InternetGateway: makeConstructor('aws:ec2/internetGateway:InternetGateway'),
    InternetGatewayAttachment: makeConstructor('aws:ec2/internetGatewayAttachment:InternetGatewayAttachment'),
    Subnet: makeConstructor('aws:ec2/subnet:Subnet'),
    RouteTable: makeConstructor('aws:ec2/routeTable:RouteTable'),
    Route: makeConstructor('aws:ec2/route:Route'),
    RouteTableAssociation: makeConstructor('aws:ec2/routeTableAssociation:RouteTableAssociation'),
    SecurityGroup: makeConstructor('aws:ec2/securityGroup:SecurityGroup'),
    KeyPair: makeConstructor('aws:ec2/keyPair:KeyPair'),
    Instance: makeConstructor('aws:ec2/instance:Instance'),
    Eip: makeConstructor('aws:ec2/eip:Eip'),
    EipAssociation: makeConstructor('aws:ec2/eipAssociation:EipAssociation'),
    getAmi: vi.fn().mockResolvedValue({ id: 'ami-mock', imageId: 'ami-mock' }),
  }

  const iam = {
    Role: makeConstructor('aws:iam/role:Role'),
    RolePolicyAttachment: makeConstructor('aws:iam/rolePolicyAttachment:RolePolicyAttachment'),
    InstanceProfile: makeConstructor('aws:iam/instanceProfile:InstanceProfile'),
  }

  return { ec2, iam }
})

// ─── Tests ────────────────────────────────────────────────────────────────────

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
  const { awsProgram } = await import('../../../src/providers/aws/program.js')
  return awsProgram()
}

describe('awsProgram — happy path', () => {
  it('runs without throwing and returns all BaseStackOutputs keys', async () => {
    setConfig({ sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAATEST test' })

    const result = await runProgram()

    expect(result).toHaveProperty('instanceId')
    expect(result).toHaveProperty('publicIp')
    expect(result).toHaveProperty('gatewayUrl')
    expect(result).toHaveProperty('sshHost')
    expect(result).toHaveProperty('sshPort', 22)
    expect(result).toHaveProperty('sshUser', 'ubuntu')
    expect(result).toHaveProperty('region')
    expect(result).toHaveProperty('provisionedAt')
  })
})

describe('awsProgram — accessMode=restricted (default)', () => {
  it('creates no ingress rules when allowedCidrs is empty', async () => {
    setConfig({ sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAATEST test' })

    await runProgram()

    const sg = created.find(r => r.type === 'aws:ec2/securityGroup:SecurityGroup')
    expect(sg).toBeDefined()
    expect((sg!.inputs['ingress'] as unknown[]) ?? []).toHaveLength(0)
  })

  it('creates 4 ingress rules when 2 allowedCidrs are set (2 CIDRs × 2 ports)', async () => {
    setConfig({
      sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAATEST test',
      accessMode: 'restricted',
      allowedCidrs: '10.0.0.1/32,10.0.0.2/32',
    })

    await runProgram()

    const sg = created.find(r => r.type === 'aws:ec2/securityGroup:SecurityGroup')
    const ingress = (sg!.inputs['ingress'] as unknown[]) ?? []
    expect(ingress).toHaveLength(4)
  })
})

describe('awsProgram — accessMode=auto', () => {
  it('uses detected egress IP as /32 ingress CIDR', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('203.0.113.42\n', { status: 200 }),
    )

    setConfig({
      sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAATEST test',
      accessMode: 'auto',
    })

    await runProgram()

    const sg = created.find(r => r.type === 'aws:ec2/securityGroup:SecurityGroup')
    const ingress = sg!.inputs['ingress'] as Array<{ cidrBlocks: string[] }>
    expect(ingress).toHaveLength(2)
    expect(ingress.every(r => r.cidrBlocks[0] === '203.0.113.42/32')).toBe(true)
  })
})

describe('awsProgram — accessMode=open', () => {
  it('uses 0.0.0.0/0 and emits a warning', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    setConfig({
      sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAATEST test',
      accessMode: 'open',
    })

    await runProgram()

    const sg = created.find(r => r.type === 'aws:ec2/securityGroup:SecurityGroup')
    const ingress = sg!.inputs['ingress'] as Array<{ cidrBlocks: string[] }>
    expect(ingress.every(r => r.cidrBlocks[0] === '0.0.0.0/0')).toBe(true)
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('accessMode=open'))
  })
})

describe('awsProgram — bedrockEnabled', () => {
  it('attaches Bedrock policy when bedrockEnabled=true', async () => {
    setConfig({
      sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAATEST test',
      bedrockEnabled: 'true',
    })

    await runProgram()

    const attachments = created.filter(r => r.type === 'aws:iam/rolePolicyAttachment:RolePolicyAttachment')
    const bedrock = attachments.find(r => String(r.inputs['policyArn']).includes('BedrockFullAccess'))
    expect(bedrock).toBeDefined()
  })

  it('does NOT attach Bedrock policy when bedrockEnabled is unset', async () => {
    setConfig({ sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAATEST test' })

    await runProgram()

    const attachments = created.filter(r => r.type === 'aws:iam/rolePolicyAttachment:RolePolicyAttachment')
    const bedrock = attachments.find(r => String(r.inputs['policyArn']).includes('BedrockFullAccess'))
    expect(bedrock).toBeUndefined()
  })
})

describe('awsProgram — sshPublicKey validation', () => {
  it('throws a clear error when sshPublicKey is missing', async () => {
    // No sshPublicKey set
    await expect(runProgram()).rejects.toThrow('sshPublicKey')
  })
})

describe('awsProgram — per-port CIDR overrides', () => {
  it('sshCidrs overrides accessMode for SSH only', async () => {
    setConfig({
      sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAATEST test',
      accessMode: 'restricted',
      sshCidrs: '192.168.1.0/24',
    })

    await runProgram()

    const sg = created.find(r => r.type === 'aws:ec2/securityGroup:SecurityGroup')
    const ingress = sg!.inputs['ingress'] as Array<{ fromPort: number; cidrBlocks: string[] }>
    const sshRules = ingress.filter(r => r.fromPort === 22)
    expect(sshRules).toHaveLength(1)
    expect(sshRules[0]!.cidrBlocks).toContain('192.168.1.0/24')
    const gwRules = ingress.filter(r => r.fromPort === 18789)
    expect(gwRules).toHaveLength(0)
  })
})
