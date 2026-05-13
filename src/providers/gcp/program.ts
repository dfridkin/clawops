// GCP inline Pulumi program — creates: Network, Subnet, Firewall, Static IP, VM.
// URN namespace: clawops:infra:* / clawops:net:*
//
// @pulumi/pulumi and @pulumi/gcp are imported INSIDE the program closure so that
// importing this module (e.g. in tests) does not trigger Pulumi SDK initialisation.

import type { PulumiFn } from '../types.js'

const GATEWAY_PORT = 18789
const SSH_PORT = 22

/**
 * Inline Pulumi program for GCP.
 * Reads instance type and region from Pulumi stack config at runtime.
 */
export const gcpProgram: PulumiFn = async () => {
  // Lazy imports: keep Pulumi SDK out of module-load graph.
  const [pulumi, gcp] = await Promise.all([
    import('@pulumi/pulumi'),
    import('@pulumi/gcp'),
  ])

  const cfg = new pulumi.Config()
  const instanceType = cfg.get('instanceType') ?? 'e2-standard-2'
  const region = cfg.get('region') ?? 'us-central1'
  const openclawVersion = cfg.get('openclawVersion') ?? 'latest'
  const zone = cfg.get('zone') ?? `${region}-a`

  // Network
  const network = new gcp.compute.Network('clawops-network', {
    autoCreateSubnetworks: false,
    description: 'clawops managed network',
  })

  const subnet = new gcp.compute.Subnetwork('clawops-subnet', {
    ipCidrRange: '10.0.0.0/24',
    region,
    network: network.id,
  })

  // Firewall: allow SSH and gateway port
  new gcp.compute.Firewall('clawops-firewall', {
    network: network.selfLink,
    allows: [
      {
        protocol: 'tcp',
        ports: [String(SSH_PORT), String(GATEWAY_PORT)],
      },
    ],
    sourceRanges: ['0.0.0.0/0'],
    targetTags: ['clawops'],
  })

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
        network: network.id,
        subnetwork: subnet.id,
        accessConfigs: [
          {
            natIp: address.address,
            networkTier: 'PREMIUM',
          },
        ],
      },
    ],
    metadata: {
      'startup-script': makeStartupScript(openclawVersion),
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

function makeStartupScript(openclawVersion: string): string {
  return `#!/bin/bash
set -euo pipefail

# Create clawops user with SSH access
id -u clawops &>/dev/null || useradd -m -s /bin/bash clawops
mkdir -p /home/clawops/.ssh
chmod 700 /home/clawops/.ssh

# Install Docker if not present
if ! command -v docker &>/dev/null; then
  apt-get update -q
  apt-get install -y -q ca-certificates curl gnupg lsb-release
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg \\
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \\
    https://download.docker.com/linux/debian $(lsb_release -cs) stable" \\
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
{"meta":{"lastTouchedVersion":"2026.4"},"gateway":{"port":18789,"auth":{"mode":"token"}},"models":{},"channels":{}}
OPENCLAWJSON
  chown clawops:clawops "\${OPENCLAW_CONFIG}"
fi

# Start OpenClaw container
docker stop openclaw 2>/dev/null || true
docker rm   openclaw 2>/dev/null || true
docker run -d \\
  --name openclaw \\
  --restart unless-stopped \\
  -p ${GATEWAY_PORT}:${GATEWAY_PORT} \\
  -v "\${OPENCLAW_CONFIG}":/app/config.json:ro \\
  ghcr.io/openclaw/openclaw:\${OPENCLAW_VERSION} \\
  node openclaw.mjs gateway run --allow-unconfigured
`
}
