// Shared Pulumi mock setup — import this at the top of any Pulumi unit test.
// Per SPEC §4.2 and Issue 9: centralise setMocks() to avoid repetition.

import * as pulumi from '@pulumi/pulumi'

export interface MockResource {
  type: string
  name: string
  inputs: Record<string, unknown>
}

const captured: MockResource[] = []

export function getCapturedResources(): MockResource[] {
  return [...captured]
}

export function clearCapturedResources(): void {
  captured.length = 0
}

/**
 * Initialise Pulumi mocks.
 * Call once per test file (outside describe blocks) — Pulumi's setMocks is global.
 *
 * @param customOutputs Optional map of resource type → extra outputs to merge.
 */
export function setupPulumiMocks(
  customOutputs: Record<string, Record<string, unknown>> = {},
): void {
  pulumi.runtime.setMocks(
    {
      newResource(args: pulumi.runtime.MockResourceArgs): { id: string; state: Record<string, unknown> } {
        captured.push({ type: args.type, name: args.name, inputs: args.inputs })

        const baseOutputs: Record<string, Record<string, unknown>> = {
          // GCP
          'gcp:compute/network:Network': { id: 'network-mock', selfLink: 'https://mock/network' },
          'gcp:compute/subnetwork:Subnetwork': { id: 'subnet-mock' },
          'gcp:compute/firewall:Firewall': { id: 'firewall-mock' },
          'gcp:compute/address:Address': { id: 'address-mock', address: '1.2.3.4' },
          'gcp:compute/instance:Instance': {
            id: 'instance-mock',
            networkInterfaces: [{ accessConfigs: [{ natIp: '1.2.3.4' }] }],
          },
          // AWS
          'aws:ec2/vpc:Vpc':                           { id: 'vpc-mock' },
          'aws:ec2/internetGateway:InternetGateway':   { id: 'igw-mock' },
          'aws:ec2/internetGatewayAttachment:InternetGatewayAttachment': { id: 'igwa-mock' },
          'aws:ec2/subnet:Subnet':                     { id: 'subnet-mock' },
          'aws:ec2/routeTable:RouteTable':             { id: 'rt-mock' },
          'aws:ec2/route:Route':                       { id: 'route-mock' },
          'aws:ec2/routeTableAssociation:RouteTableAssociation': { id: 'rta-mock' },
          'aws:ec2/securityGroup:SecurityGroup':       { id: 'sg-mock' },
          'aws:ec2/keyPair:KeyPair':                   { id: 'kp-mock', keyName: 'kp-mock' },
          'aws:iam/role:Role':                         { id: 'role-mock', arn: 'arn:aws:iam::123456789012:role/mock' },
          'aws:iam/rolePolicyAttachment:RolePolicyAttachment': { id: 'rpa-mock' },
          'aws:iam/instanceProfile:InstanceProfile':   { id: 'ip-mock', arn: 'arn:aws:iam::123456789012:instance-profile/mock' },
          'aws:ec2/instance:Instance':                 { id: 'i-mock', publicIp: '1.2.3.4' },
          'aws:ec2/eip:Eip':                           { id: 'eip-mock', publicIp: '5.6.7.8' },
          'aws:ec2/eipAssociation:EipAssociation':     { id: 'eipassoc-mock' },
          // Azure
          'azure-native:resources:ResourceGroup':      { id: '/subscriptions/mock/resourceGroups/rg-mock', name: 'rg-mock', location: 'eastus' },
          'azure-native:network:VirtualNetwork':       { id: 'vnet-mock' },
          'azure-native:network:Subnet':               { id: 'subnet-mock' },
          'azure-native:network:NetworkSecurityGroup': { id: 'nsg-mock' },
          'azure-native:network:PublicIPAddress':      { id: 'pip-mock', ipAddress: '5.6.7.8' },
          'azure-native:network:NetworkInterface':     { id: 'nic-mock' },
          'azure-native:compute:VirtualMachine':       { id: 'vm-mock', identity: { principalId: 'mock-principal', tenantId: 'mock-tenant', type: 'SystemAssigned' } },
          'azure-native:keyvault:Vault':               { id: 'kv-mock', properties: { vaultUri: 'https://mock.vault.azure.net/' } },
          'azure-native:authorization:RoleAssignment': { id: 'ra-mock' },
          'azure-native:keyvault:Secret':              { id: 'secret-mock' },
        }

        const merged = {
          ...(baseOutputs[args.type] ?? {}),
          ...(customOutputs[args.type] ?? {}),
          ...args.inputs,
        }

        return { id: `${args.name}-id`, state: merged }
      },
      call(args: pulumi.runtime.MockCallArgs): Record<string, unknown> {
        // Handle AWS data source invocations
        if (args.token === 'aws:ec2/getAmi:getAmi') {
          return { id: 'ami-mock-ubuntu2204', imageId: 'ami-mock-ubuntu2204', ...args.inputs }
        }
        return args.inputs
      },
    },
    'test-project',
    'test-stack',
  )
}
