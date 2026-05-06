// Azure inline Pulumi program — creates: Resource Group, VNet, Subnet, NSG,
// Public IP, Network Interface, VM. Optional: Key Vault + Role Assignment + Secret.
// URN namespace: clawops:infra:* / clawops:net:*

import type { PulumiFn } from '../types.js'

const GATEWAY_PORT = 18789
const SSH_PORT = 22

export const azureProgram: PulumiFn = async () => {
  const [pulumi, azure, { resolveIngressCidrs, detectEgressIp }] = await Promise.all([
    import('@pulumi/pulumi'),
    import('@pulumi/azure-native'),
    import('../firewall.js'),
  ])

  const cfg = new pulumi.Config()
  const stackName = pulumi.getStack()
  const instanceType = cfg.get('instanceType') ?? 'Standard_B2s'
  const location = cfg.get('region') ?? 'eastus'
  const openclawVersion = cfg.get('openclawVersion') ?? 'stable'
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

  // Detect egress IP for 'auto' mode
  const detectedIp = accessMode === 'auto'
    ? await detectEgressIp('https://ifconfig.me')
    : ''

  if (accessMode === 'open') {
    process.stderr.write(
      '[clawops] WARNING: accessMode=open allows 0.0.0.0/0 on SSH and gateway ports. ' +
      'Only use this for development/sandbox stacks.\n',
    )
  }

  const sshIngressCidrs = resolveIngressCidrs(accessMode, allowedCidrs, sshCidrs, detectedIp)
  const gatewayIngressCidrs = resolveIngressCidrs(accessMode, allowedCidrs, gatewayCidrs, detectedIp)

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
  const vm = new azure.compute.VirtualMachine('clawops-vm', {
    resourceGroupName: rg.name,
    location: rg.location,
    hardwareProfile: { vmSize: instanceType },
    identity: { type: 'SystemAssigned' },
    osProfile: {
      adminUsername: 'clawops',
      computerName: 'clawops',
      customData: Buffer.from(makeStartupScript(openclawVersion)).toString('base64'),
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
        offer: 'UbuntuServer',
        sku: '22.04-LTS',
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
    // Enforce max 24-char Key Vault name
    const rawKvName = `clawops-${stackName}-kv`
    const kvName = rawKvName.length > 24 ? rawKvName.slice(0, 24) : rawKvName

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

    new azure.authorization.RoleAssignment('clawops-kv-role', {
      scope: kv.id,
      roleDefinitionId: '/providers/Microsoft.Authorization/roleDefinitions/4633458b-17de-408a-b874-0445c86b69e6', // Key Vault Secrets User
      principalId: pulumi.output(vm.identity).apply(i => i?.principalId ?? ''),
      principalType: 'ServicePrincipal',
    })

    new azure.keyvault.Secret('clawops-gateway-token', {
      resourceGroupName: rg.name,
      vaultName: kv.name,
      secretName: 'gateway-token',
      properties: { value: 'CHANGEME' },
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

function makeStartupScript(openclawVersion: string): string {
  return `#!/bin/bash
set -euo pipefail

# Install Docker if not present
if ! command -v docker &>/dev/null; then
  apt-get update -q
  apt-get install -y -q ca-certificates curl gnupg lsb-release
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \\
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \\
    https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \\
    > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -y -q docker-ce docker-ce-cli containerd.io
  systemctl enable --now docker
fi

usermod -aG docker clawops

# Pull OpenClaw image
OPENCLAW_VERSION="${openclawVersion}"
docker pull ghcr.io/openclaw/openclaw:\${OPENCLAW_VERSION}

# Create default openclaw.json if not present
OPENCLAW_CONFIG=/home/clawops/openclaw.json
if [ ! -f "\${OPENCLAW_CONFIG}" ]; then
  cat > "\${OPENCLAW_CONFIG}" <<'OPENCLAWJSON'
{"version":"2026.4","gateway":{"port":18789,"auth":{"mode":"token"}},"models":{},"channels":[]}
OPENCLAWJSON
  chown clawops:clawops "\${OPENCLAW_CONFIG}"
fi

# Start OpenClaw container
docker stop openclaw 2>/dev/null || true
docker rm   openclaw 2>/dev/null || true
docker run -d \\
  --name openclaw \\
  --restart unless-stopped \\
  -p 18789:18789 \\
  -v "\${OPENCLAW_CONFIG}":/app/config.json:ro \\
  ghcr.io/openclaw/openclaw:\${OPENCLAW_VERSION}
`
}
