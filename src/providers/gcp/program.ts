// GCP inline Pulumi program — creates: Network, Subnet, Firewall, Static IP, VM.
// URN namespace: clawops:infra:* / clawops:net:*
//
// @pulumi/pulumi and @pulumi/gcp are imported INSIDE the program closure so that
// importing this module (e.g. in tests) does not trigger Pulumi SDK initialisation.

import type { PulumiFn } from '../types.js'
import { makeStartupScript } from '../startup.js'

const GATEWAY_PORT = 18789
const SSH_PORT = 22

/**
 * Inline Pulumi program for GCP.
 * Reads instance type and region from Pulumi stack config at runtime.
 */
export const gcpProgram: PulumiFn = async () => {
  const [pulumi, gcp, { resolveIngressCidrs, detectEgressIp }] = await Promise.all([
    import('@pulumi/pulumi'),
    import('@pulumi/gcp'),
    import('../firewall.js'),
  ])

  const cfg = new pulumi.Config()
  const instanceType = cfg.get('instanceType') ?? 'e2-standard-2'
  const region = cfg.get('region') ?? 'us-central1'
  const openclawVersion = cfg.get('openclawVersion') ?? 'latest'
  const zone = cfg.get('zone') ?? `${region}-a`
  const accessMode = cfg.get('accessMode') ?? 'restricted'
  const allowedCidrs = cfg.get('allowedCidrs') ?? ''
  const sshCidrs = cfg.get('sshCidrs') ?? ''
  const gatewayCidrs = cfg.get('gatewayCidrs') ?? ''

  const sshPublicKey = cfg.get('sshPublicKey')
  if (!sshPublicKey) {
    throw new Error(
      'Stack config "sshPublicKey" is required for the GCP adapter. ' +
      'Set it with: pulumi config set --stack <name> sshPublicKey "ssh-ed25519 ..."',
    )
  }

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

  // Network
  const network = new gcp.compute.Network('clawops-network', {
    autoCreateSubnetworks: false,
    description: 'clawops managed network',
  })

  const subnet = new gcp.compute.Subnetwork('clawops-subnet', {
    ipCidrRange: '10.0.0.0/24',
    region,
    network: network.selfLink,
  })

  // Firewall: separate rules per port so CIDRs can differ
  if (sshIngressCidrs.length > 0) {
    new gcp.compute.Firewall('clawops-firewall-ssh', {
      network: network.selfLink,
      allows: [{ protocol: 'tcp', ports: [String(SSH_PORT)] }],
      sourceRanges: sshIngressCidrs,
      targetTags: ['clawops'],
    })
  }

  if (gatewayIngressCidrs.length > 0) {
    new gcp.compute.Firewall('clawops-firewall-gateway', {
      network: network.selfLink,
      allows: [{ protocol: 'tcp', ports: [String(GATEWAY_PORT)] }],
      sourceRanges: gatewayIngressCidrs,
      targetTags: ['clawops'],
    })
  }

  // Static external IP
  const address = new gcp.compute.Address('clawops-address', { region })

  // Compute Engine VM (Debian 12)
  const instance = new gcp.compute.Instance('clawops-instance', {
    machineType: instanceType,
    zone,
    tags: ['clawops'],
    bootDisk: {
      initializeParams: {
        image: 'debian-cloud/debian-12',
        size: 20,
      },
    },
    networkInterfaces: [
      {
        network: network.selfLink,
        subnetwork: subnet.selfLink,
        accessConfigs: [
          {
            natIp: address.address,
            networkTier: 'PREMIUM',
          },
        ],
      },
    ],
    metadata: {
      // GCP guest agent reads 'ssh-keys' and populates /home/<user>/.ssh/authorized_keys
      'ssh-keys': `clawops:${sshPublicKey}`,
      'startup-script': makeStartupScript({ openclawVersion, os: 'debian' }),
    },
    serviceAccount: {
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    },
  })

  return {
    instanceId: instance.id,
    publicIp: address.address,
    gatewayUrl: pulumi.interpolate`https://${address.address}:${GATEWAY_PORT}`,
    sshHost: address.address,
    sshPort: SSH_PORT,
    sshUser: 'clawops',
    region,
    provisionedAt: new Date().toISOString(),
  }
}
