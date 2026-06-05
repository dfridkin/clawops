// Azure inline Pulumi program — creates: Resource Group, VNet, Subnet, NSG,
// Public IP, Network Interface, VM. Optional: Key Vault + Role Assignment + Secret.
// URN namespace: clawops:infra:* / clawops:net:*

import { createHash } from 'node:crypto'
import type { PulumiFn } from '../types.js'
import { makeStartupScript } from '../startup.js'

const GATEWAY_PORT = 18789
const SSH_PORT = 22

export const azureProgram: PulumiFn = async () => {
  const [pulumi, azure, random, { resolveIngressCidrs, detectEgressIp }] = await Promise.all([
    import('@pulumi/pulumi'),
    import('@pulumi/azure-native'),
    import('@pulumi/random'),
    import('../firewall.js'),
  ])

  const cfg = new pulumi.Config()
  const stackName = pulumi.getStack()
  const instanceType = cfg.get('instanceType') ?? 'Standard_B2s'
  const location = cfg.get('region') ?? 'eastus'
  const openclawVersion = cfg.get('openclawVersion') ?? 'latest'
  const accessMode = cfg.get('accessMode') ?? 'restricted'
  const allowedCidrs = cfg.get('allowedCidrs') ?? ''
  const sshCidrs = cfg.get('sshCidrs') ?? ''
  const gatewayCidrs = cfg.get('gatewayCidrs') ?? ''
  const keyVaultEnabled = cfg.get('keyVaultEnabled') === 'true'
  const resourceGroupName = cfg.get('resourceGroupName') ?? `clawops-${stackName}`

  const sshPublicKey = cfg.get('sshPublicKey')
  if (!sshPublicKey) {
    throw new Error(
      'Stack config "sshPublicKey" is required for the Azure adapter. ' +
      'Set it with: pulumi config set --stack <name> sshPublicKey "ssh-ed25519 ..."',
    )
  }

  // Hoist subscription lookup alongside other async initialisations.
  // Any future data-source calls (e.g. getResourceGroup) should be batched
  // here with Promise.all to avoid sequential await latency.
  const clientConfig = await azure.authorization.getClientConfig({})

  // Detect egress IP for 'auto' mode using a provider-neutral service.
  const egressResult = accessMode === 'auto'
    ? await detectEgressIp('https://ifconfig.me')
    : { ok: true as const, ip: '' }

  if (accessMode === 'open') {
    process.stderr.write(
      '[clawops] WARNING: accessMode=open allows 0.0.0.0/0 on SSH and gateway ports. ' +
      'Only use this for development/sandbox stacks.\n',
    )
  }

  const sshIngressCidrs = resolveIngressCidrs(accessMode, allowedCidrs, sshCidrs, egressResult)
  const gatewayIngressCidrs = resolveIngressCidrs(accessMode, allowedCidrs, gatewayCidrs, egressResult)

  // --- Resource Group ---
  const rg = new azure.resources.ResourceGroup('clawops-rg', {
    resourceGroupName,
    location,
  })

  // --- Virtual Network + Subnet ---
  const vnet = new azure.network.VirtualNetwork('clawops-vnet', {
    resourceGroupName: rg.name,
    location: rg.location,
    addressSpace: { addressPrefixes: ['10.0.0.0/16'] },
  })

  const subnet = new azure.network.Subnet('clawops-subnet', {
    resourceGroupName: rg.name,
    virtualNetworkName: vnet.name,
    addressPrefix: '10.0.1.0/24',
  })

  // --- Network Security Group ---
  type SecurityRuleArgs = {
    name: string
    priority: number
    direction: string
    access: string
    protocol: string
    sourceAddressPrefix: string
    sourcePortRange: string
    destinationAddressPrefix: string
    destinationPortRange: string
  }

  const securityRules: SecurityRuleArgs[] = []
  let priority = 100

  for (const cidr of sshIngressCidrs) {
    securityRules.push({
      name: `allow-ssh-${priority}`,
      priority: priority++,
      direction: 'Inbound',
      access: 'Allow',
      protocol: 'Tcp',
      sourceAddressPrefix: cidr,
      sourcePortRange: '*',
      destinationAddressPrefix: '*',
      destinationPortRange: String(SSH_PORT),
    })
  }

  for (const cidr of gatewayIngressCidrs) {
    securityRules.push({
      name: `allow-gateway-${priority}`,
      priority: priority++,
      direction: 'Inbound',
      access: 'Allow',
      protocol: 'Tcp',
      sourceAddressPrefix: cidr,
      sourcePortRange: '*',
      destinationAddressPrefix: '*',
      destinationPortRange: String(GATEWAY_PORT),
    })
  }

  const nsg = new azure.network.NetworkSecurityGroup('clawops-nsg', {
    resourceGroupName: rg.name,
    location: rg.location,
    securityRules,
  })

  // --- Public IP ---
  const publicIp = new azure.network.PublicIPAddress('clawops-pip', {
    resourceGroupName: rg.name,
    location: rg.location,
    publicIPAllocationMethod: 'Static',
    sku: { name: 'Standard' },
  })

  // --- Network Interface ---
  const nic = new azure.network.NetworkInterface('clawops-nic', {
    resourceGroupName: rg.name,
    location: rg.location,
    networkSecurityGroup: { id: nsg.id },
    ipConfigurations: [{
      name: 'clawops-ipconfig',
      subnet: { id: subnet.id },
      publicIPAddress: { id: publicIp.id },
      privateIPAllocationMethod: 'Dynamic',
    }],
  })

  // --- Virtual Machine ---
  // customData must be base64-encoded: the azure-native provider passes the
  // string as-is to the ARM REST API, which requires it pre-encoded.
  const vm = new azure.compute.VirtualMachine('clawops-vm', {
    resourceGroupName: rg.name,
    location: rg.location,
    hardwareProfile: { vmSize: instanceType },
    identity: { type: 'SystemAssigned' },
    osProfile: {
      adminUsername: 'clawops',
      computerName: 'clawops',
      customData: Buffer.from(makeStartupScript({ openclawVersion, os: 'ubuntu' })).toString('base64'),
      linuxConfiguration: {
        disablePasswordAuthentication: true,
        ssh: {
          publicKeys: [{
            keyData: sshPublicKey,
            path: '/home/clawops/.ssh/authorized_keys',
          }],
        },
      },
    },
    storageProfile: {
      imageReference: {
        publisher: 'Canonical',
        // Ubuntu 22.04 LTS — Canonical migrated from the legacy 'UbuntuServer'
        // offer to this naming scheme. 22_04-lts-gen2 is available in all regions.
        offer: '0001-com-ubuntu-server-jammy',
        sku: '22_04-lts-gen2',
        version: 'latest',
      },
      osDisk: {
        createOption: 'FromImage',
        managedDisk: { storageAccountType: 'Premium_LRS' },
        diskSizeGB: 30,
      },
    },
    networkProfile: {
      networkInterfaces: [{ id: nic.id, primary: true }],
    },
  })

  // --- Optional: Key Vault ---
  if (keyVaultEnabled) {
    // Azure KV names: 3–24 chars, alphanumeric + hyphens, globally unique.
    const safeName = stackName.replace(/[^a-zA-Z0-9-]/g, '-')
    const rawKvName = `clawops-${safeName}-kv`
    const kvName = rawKvName.length > 24
      ? `cl-${createHash('sha256').update(stackName).digest('hex').slice(0, 20)}`
      : rawKvName

    const kv = new azure.keyvault.Vault('clawops-kv', {
      resourceGroupName: rg.name,
      location: rg.location,
      vaultName: kvName,
      properties: {
        sku: { family: 'A', name: 'standard' },
        tenantId: pulumi.output(vm.identity).apply(i => i?.tenantId ?? ''),
        enableRbacAuthorization: true,
      },
    })

    // roleDefinitionId must include the subscription scope for the ARM API.
    // 4633458b-17de-408a-b874-0445c86b69e6 = Key Vault Secrets User (built-in).
    const kvSecretsUserRoleId =
      `/subscriptions/${clientConfig.subscriptionId}` +
      `/providers/Microsoft.Authorization/roleDefinitions/4633458b-17de-408a-b874-0445c86b69e6`

    new azure.authorization.RoleAssignment('clawops-kv-role', {
      scope: kv.id,
      roleDefinitionId: kvSecretsUserRoleId,
      principalId: pulumi.output(vm.identity).apply(i => i?.principalId ?? ''),
      principalType: 'ServicePrincipal',
    })

    const gatewayToken = new random.RandomPassword('clawops-kv-gateway-token', {
      length: 32,
      special: false,
    })

    new azure.keyvault.Secret('clawops-gateway-token', {
      resourceGroupName: rg.name,
      vaultName: kv.name,
      secretName: 'gateway-token',
      properties: { value: gatewayToken.result },
    })
  }

  const resolvedIp = pulumi.output(publicIp.ipAddress).apply(ip => ip ?? '')

  return {
    instanceId: vm.id,
    publicIp: resolvedIp,
    gatewayUrl: pulumi.interpolate`https://${resolvedIp}:${GATEWAY_PORT}`,
    sshHost: resolvedIp,
    sshPort: SSH_PORT,
    sshUser: 'clawops',
    region: location,
    provisionedAt: new Date().toISOString(),
  }
}
