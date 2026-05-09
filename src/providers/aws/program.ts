// AWS inline Pulumi program — creates: VPC, IGW, Subnet, Route Table, Security Group,
// IAM Role + Instance Profile, Key Pair, EC2 Instance, Elastic IP.
// URN namespace: clawops:infra:* / clawops:net:*

import type { PulumiFn } from '../types.js'

const GATEWAY_PORT = 18789
const SSH_PORT = 22

export const awsProgram: PulumiFn = async () => {
  const [pulumi, aws, { resolveIngressCidrs, detectEgressIp }] = await Promise.all([
    import('@pulumi/pulumi'),
    import('@pulumi/aws'),
    import('../firewall.js'),
  ])

  const cfg = new pulumi.Config()
  const instanceType = cfg.get('instanceType') ?? 't3.small'
  const region = cfg.get('region') ?? 'us-east-1'
  const openclawVersion = cfg.get('openclawVersion') ?? 'stable'
  const accessMode = cfg.get('accessMode') ?? 'restricted'
  const allowedCidrs = cfg.get('allowedCidrs') ?? ''
  const sshCidrs = cfg.get('sshCidrs') ?? ''
  const gatewayCidrs = cfg.get('gatewayCidrs') ?? ''
  const bedrockEnabled = cfg.get('bedrockEnabled') === 'true'

  const sshPublicKey = cfg.get('sshPublicKey')
  if (!sshPublicKey) {
    throw new Error(
      'Stack config "sshPublicKey" is required for the AWS adapter. ' +
      'Set it with: pulumi config set --stack <name> sshPublicKey "ssh-ed25519 ..."',
    )
  }

  // Detect egress IP for 'auto' mode
  const detectedIp = accessMode === 'auto'
    ? await detectEgressIp('https://checkip.amazonaws.com')
    : ''

  if (accessMode === 'open') {
    process.stderr.write(
      '[clawops] WARNING: accessMode=open allows 0.0.0.0/0 on SSH and gateway ports. ' +
      'Only use this for development/sandbox stacks.\n',
    )
  }

  const sshIngressCidrs = resolveIngressCidrs(accessMode, allowedCidrs, sshCidrs, detectedIp)
  const gatewayIngressCidrs = resolveIngressCidrs(accessMode, allowedCidrs, gatewayCidrs, detectedIp)

  // --- Networking ---
  const vpc = new aws.ec2.Vpc('clawops-vpc', {
    cidrBlock: '10.0.0.0/16',
    enableDnsHostnames: true,
    enableDnsSupport: true,
    tags: { Name: 'clawops' },
  })

  const igw = new aws.ec2.InternetGateway('clawops-igw', {
    tags: { Name: 'clawops' },
  })

  new aws.ec2.InternetGatewayAttachment('clawops-igw-attach', {
    vpcId: vpc.id,
    internetGatewayId: igw.id,
  })

  const subnet = new aws.ec2.Subnet('clawops-subnet', {
    vpcId: vpc.id,
    cidrBlock: '10.0.1.0/24',
    mapPublicIpOnLaunch: false,
    availabilityZone: pulumi.interpolate`${region}a`,
    tags: { Name: 'clawops' },
  })

  const routeTable = new aws.ec2.RouteTable('clawops-rt', {
    vpcId: vpc.id,
    tags: { Name: 'clawops' },
  })

  new aws.ec2.Route('clawops-route', {
    routeTableId: routeTable.id,
    destinationCidrBlock: '0.0.0.0/0',
    gatewayId: igw.id,
  })

  new aws.ec2.RouteTableAssociation('clawops-rta', {
    subnetId: subnet.id,
    routeTableId: routeTable.id,
  })

  // --- Security Group ---
  type IngressRule = {
    protocol: string
    fromPort: number
    toPort: number
    cidrBlocks: string[]
    description: string
  }

  const ingressRules: IngressRule[] = [
    ...sshIngressCidrs.map((cidr): IngressRule => ({
      protocol: 'tcp', fromPort: SSH_PORT, toPort: SSH_PORT,
      cidrBlocks: [cidr], description: 'SSH',
    })),
    ...gatewayIngressCidrs.map((cidr): IngressRule => ({
      protocol: 'tcp', fromPort: GATEWAY_PORT, toPort: GATEWAY_PORT,
      cidrBlocks: [cidr], description: 'OpenClaw gateway',
    })),
  ]

  const sg = new aws.ec2.SecurityGroup('clawops-sg', {
    vpcId: vpc.id,
    ingress: ingressRules,
    egress: [{
      protocol: '-1',
      fromPort: 0,
      toPort: 0,
      cidrBlocks: ['0.0.0.0/0'],
      description: 'Allow all egress',
    }],
    tags: { Name: 'clawops' },
  })

  // --- IAM ---
  const role = new aws.iam.Role('clawops-role', {
    assumeRolePolicy: JSON.stringify({
      Version: '2012-10-17',
      Statement: [{
        Effect: 'Allow',
        Principal: { Service: 'ec2.amazonaws.com' },
        Action: 'sts:AssumeRole',
      }],
    }),
    tags: { Name: 'clawops' },
  })

  new aws.iam.RolePolicyAttachment('clawops-ssm', {
    role: role.name,
    policyArn: 'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore',
  })

  if (bedrockEnabled) {
    new aws.iam.RolePolicyAttachment('clawops-bedrock', {
      role: role.name,
      policyArn: 'arn:aws:iam::aws:policy/AmazonBedrockReadOnly',
    })
  }

  const instanceProfile = new aws.iam.InstanceProfile('clawops-profile', {
    role: role.name,
  })

  // --- Key Pair ---
  const keyPair = new aws.ec2.KeyPair('clawops-keypair', {
    publicKey: sshPublicKey,
    tags: { Name: 'clawops' },
  })

  // --- AMI lookup (Ubuntu 22.04 LTS) ---
  const ami = await aws.ec2.getAmi({
    mostRecent: true,
    owners: ['099720109477'], // Canonical
    filters: [
      { name: 'name', values: ['ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*'] },
      { name: 'virtualization-type', values: ['hvm'] },
    ],
  })

  // --- EC2 Instance ---
  const instance = new aws.ec2.Instance('clawops-instance', {
    ami: ami.id,
    instanceType,
    subnetId: subnet.id,
    vpcSecurityGroupIds: [sg.id],
    iamInstanceProfile: instanceProfile.name,
    keyName: keyPair.keyName,
    userData: makeStartupScript(openclawVersion, bedrockEnabled),
    tags: { Name: 'clawops' },
  })

  // --- Elastic IP ---
  const eip = new aws.ec2.Eip('clawops-eip', {
    domain: 'vpc',
    tags: { Name: 'clawops' },
  })

  new aws.ec2.EipAssociation('clawops-eip-assoc', {
    instanceId: instance.id,
    allocationId: eip.id,
  })

  return {
    instanceId: instance.id,
    publicIp: eip.publicIp,
    gatewayUrl: pulumi.interpolate`https://${eip.publicIp}:${GATEWAY_PORT}`,
    sshHost: eip.publicIp,
    sshPort: SSH_PORT,
    sshUser: 'ubuntu',
    region,
    provisionedAt: new Date().toISOString(),
  }
}

function makeStartupScript(openclawVersion: string, bedrockEnabled: boolean): string {
  const bedrockEnvFile = bedrockEnabled
    ? `\n# Write AWS_PROFILE for Bedrock\necho "AWS_PROFILE=default" > /etc/openclaw.env\n`
    : ''

  return `#!/bin/bash
set -euo pipefail

# Create clawops user with SSH access
id -u clawops &>/dev/null || useradd -m -s /bin/bash clawops
mkdir -p /home/clawops/.ssh
chmod 700 /home/clawops/.ssh
chown clawops:clawops /home/clawops/.ssh

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
${bedrockEnvFile}
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
  ghcr.io/openclaw/openclaw:\${OPENCLAW_VERSION}
`
}
