// AWS Pulumi program unit tests.
// Uses vi.mock to stub @pulumi/aws and @pulumi/pulumi — no gRPC, no engine.

import { describe, it, expect, beforeEach, vi } from 'vitest'

// ─── Pulumi mock ──────────────────────────────────────────────────────────────

type ResourceEntry = { type: string; name: string; inputs: Record<string, unknown> }
const created: ResourceEntry[] = []

const configValues: Record<string, string> = {}

function mockConfig() {
  return { get: (key: string) => configValues[key] }
}

vi.mock('@pulumi/pulumi', () => {
  class MockResource {
    id: string
    name: string
    constructor(name: string, inputs: Record<string, unknown> = {}) {
      this.name = name
      this.id = `${name}-id`
      Object.assign(this, inputs)
    }
  }

  return {
    Config: vi.fn(() => mockConfig()),
    getStack: vi.fn(() => 'test-stack'),
    output: (val: unknown) => ({ apply: (fn: (v: unknown) => unknown) => fn(val) }),
    interpolate: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.raw.reduce((acc, part, i) => acc + part + (values[i] ?? ''), ''),
    ComponentResource: MockResource,
  }
})

vi.mock('@pulumi/aws', async () => {
  function makeConstructor(type: string) {
    return class {
      id: string
      keyName: string
      name: string
      publicIp: string
      constructor(name: string, inputs: Record<string, unknown> = {}) {
        this.id = `${name}-id`
        this.keyName = `${name}-keyName`
        this.name = `${name}-name`
        this.publicIp = '1.2.3.4'
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
    getAmi: vi.fn().mockResolvedValue({ id: 'ami-mock' }),
  }

  const iam = {
    Role: makeConstructor('aws:iam/role:Role'),
    RolePolicyAttachment: makeConstructor('aws:iam/rolePolicyAttachment:RolePolicyAttachment'),
    RolePolicy: makeConstructor('aws:iam/rolePolicy:RolePolicy'),
    InstanceProfile: makeConstructor('aws:iam/instanceProfile:InstanceProfile'),
  }

  const vpc = {
    SecurityGroupIngressRule: makeConstructor('aws:vpc/securityGroupIngressRule:SecurityGroupIngressRule'),
    SecurityGroupEgressRule: makeConstructor('aws:vpc/securityGroupEgressRule:SecurityGroupEgressRule'),
  }

  return { ec2, iam, vpc }
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
  const { awsProgram } = await import('../../../src/providers/aws/program.js')
  return awsProgram()
}

// ─── Tests ────────────────────────────────────────────────────────────────────

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

describe('awsProgram — SecurityGroupIngressRule resources (not inline ingress)', () => {
  it('creates no ingress rules when allowedCidrs is empty', async () => {
    setConfig({ sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAATEST test' })
    await runProgram()
    const rules = created.filter(r => r.type === 'aws:vpc/securityGroupIngressRule:SecurityGroupIngressRule')
    expect(rules).toHaveLength(0)
  })

  it('creates 4 ingress rules for 2 CIDRs × 2 ports', async () => {
    setConfig({
      sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAATEST test',
      accessMode: 'restricted',
      allowedCidrs: '10.0.0.1/32,10.0.0.2/32',
    })
    await runProgram()
    const rules = created.filter(r => r.type === 'aws:vpc/securityGroupIngressRule:SecurityGroupIngressRule')
    expect(rules).toHaveLength(4)
  })

  it('creates 1 egress rule (allow-all outbound)', async () => {
    setConfig({ sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAATEST test' })
    await runProgram()
    const egress = created.filter(r => r.type === 'aws:vpc/securityGroupEgressRule:SecurityGroupEgressRule')
    expect(egress).toHaveLength(1)
    expect(egress[0]!.inputs['cidrIpv4']).toBe('0.0.0.0/0')
    expect(egress[0]!.inputs['ipProtocol']).toBe('-1')
  })

  it('SecurityGroup itself has no inline ingress property', async () => {
    setConfig({
      sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAATEST test',
      allowedCidrs: '10.0.0.1/32',
    })
    await runProgram()
    const sg = created.find(r => r.type === 'aws:ec2/securityGroup:SecurityGroup')
    expect(sg).toBeDefined()
    expect(sg!.inputs['ingress']).toBeUndefined()
    expect(sg!.inputs['egress']).toBeUndefined()
  })

  it('SSH rules target port 22', async () => {
    setConfig({
      sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAATEST test',
      allowedCidrs: '10.0.0.1/32',
    })
    await runProgram()
    const rules = created.filter(r => r.type === 'aws:vpc/securityGroupIngressRule:SecurityGroupIngressRule')
    const sshRules = rules.filter(r => r.inputs['fromPort'] === 22)
    expect(sshRules).toHaveLength(1)
    expect(sshRules[0]!.inputs['cidrIpv4']).toBe('10.0.0.1/32')
  })

  it('gateway rules target port 18789', async () => {
    setConfig({
      sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAATEST test',
      allowedCidrs: '10.0.0.1/32',
    })
    await runProgram()
    const rules = created.filter(r => r.type === 'aws:vpc/securityGroupIngressRule:SecurityGroupIngressRule')
    const gwRules = rules.filter(r => r.inputs['fromPort'] === 18789)
    expect(gwRules).toHaveLength(1)
    expect(gwRules[0]!.inputs['cidrIpv4']).toBe('10.0.0.1/32')
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
    const rules = created.filter(r => r.type === 'aws:vpc/securityGroupIngressRule:SecurityGroupIngressRule')
    expect(rules.length).toBeGreaterThan(0)
    expect(rules.every(r => r.inputs['cidrIpv4'] === '203.0.113.42/32')).toBe(true)
  })

  it('throws when egress IP detection fails — never silently locks out', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network error'))
    setConfig({
      sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAATEST test',
      accessMode: 'auto',
    })
    await expect(runProgram()).rejects.toThrow(/egress IP detection failed/)
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
    const rules = created.filter(r => r.type === 'aws:vpc/securityGroupIngressRule:SecurityGroupIngressRule')
    expect(rules.every(r => r.inputs['cidrIpv4'] === '0.0.0.0/0')).toBe(true)
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('accessMode=open'))
  })
})

describe('awsProgram — metadataOptions', () => {
  it('sets IMDSv2 with hopLimit=2', async () => {
    setConfig({ sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAATEST test' })
    await runProgram()
    const instance = created.find(r => r.type === 'aws:ec2/instance:Instance')
    const meta = instance!.inputs['metadataOptions'] as { httpTokens: string; httpPutResponseHopLimit: number }
    expect(meta.httpTokens).toBe('required')
    expect(meta.httpPutResponseHopLimit).toBe(2)
  })
})

describe('awsProgram — Bedrock IAM', () => {
  it('creates an inline RolePolicy (not FullAccess attachment) when bedrockEnabled=true', async () => {
    setConfig({
      sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAATEST test',
      bedrockEnabled: 'true',
    })
    await runProgram()
    // Must use RolePolicy (inline), not RolePolicyAttachment with FullAccess
    const inlinePolicies = created.filter(r => r.type === 'aws:iam/rolePolicy:RolePolicy')
    expect(inlinePolicies).toHaveLength(1)
    const policyDoc = JSON.parse(inlinePolicies[0]!.inputs['policy'] as string)
    const actions: string[] = policyDoc.Statement[0].Action
    expect(actions).toContain('bedrock:InvokeModel')
    expect(actions).toContain('bedrock:InvokeModelWithResponseStream')
    expect(actions).toHaveLength(2)
  })

  it('does NOT attach AmazonBedrockFullAccess when bedrockEnabled=true', async () => {
    setConfig({
      sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAATEST test',
      bedrockEnabled: 'true',
    })
    await runProgram()
    const attachments = created.filter(r => r.type === 'aws:iam/rolePolicyAttachment:RolePolicyAttachment')
    const fullAccess = attachments.find(r => String(r.inputs['policyArn']).includes('BedrockFullAccess'))
    expect(fullAccess).toBeUndefined()
  })

  it('does NOT create Bedrock inline policy when bedrockEnabled is unset', async () => {
    setConfig({ sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAATEST test' })
    await runProgram()
    const inlinePolicies = created.filter(r => r.type === 'aws:iam/rolePolicy:RolePolicy')
    expect(inlinePolicies).toHaveLength(0)
  })

  it('startup script uses IMDSv2 token flow for AWS_DEFAULT_REGION when bedrockEnabled=true', async () => {
    setConfig({
      sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAATEST test',
      bedrockEnabled: 'true',
    })
    await runProgram()
    const instance = created.find(r => r.type === 'aws:ec2/instance:Instance')
    const userData = instance!.inputs['userData'] as string
    expect(userData).toContain('AWS_DEFAULT_REGION')
    // Verify IMDSv2 two-step: PUT then GET
    expect(userData).toContain('-X PUT')
    expect(userData).toContain('X-aws-ec2-metadata-token')
    // Must NOT use bare IMDSv1 curl
    expect(userData).not.toMatch(/curl -sf http:\/\/169\.254\.169\.254.*region[^X]/)
  })
})

describe('awsProgram — sshPublicKey validation', () => {
  it('throws a clear error when sshPublicKey is missing', async () => {
    await expect(runProgram()).rejects.toThrow('sshPublicKey')
  })
})
