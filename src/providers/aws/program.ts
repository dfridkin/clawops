// AWS inline Pulumi program — creates: VPC, IGW, Subnet, Route Table,
// Security Group + individual Ingress/Egress rules, IAM Role + Instance Profile,
// Key Pair, EC2 Instance, Elastic IP.
// URN namespace: clawops:infra:* / clawops:net:*

import type { PulumiFn } from '../types.js'
import { makeStartupScript } from '../startup.js'

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
  const openclawVersion = cfg.get('openclawVersion') ?? 'latest'
  const accessMode = cfg.get('accessMode') ?? 'restricted'
  const allowedCidrs = cfg.get('allowedCidrs') ?? ''
  const sshCidrs = cfg.get('sshCidrs') ?? ''
  const gatewayCidrs = cfg.get('gatewayCidrs') ?? ''
  const bedrockEnabled = cfg.get('bedrockEnabled') === 'true'

  // Optional: pin the AMI rather than using the most-recent lookup.
  // Useful when you need plan → apply reproducibility.
  const pinnedAmiId = cfg.get('amiId')

  const sshPublicKey = cfg.get('sshPublicKey')
  if (!sshPublicKey) {
    throw new Error(
      'Stack config "sshPublicKey" is required for the AWS adapter. ' +
      'Set it with: pulumi config set --stack <name> sshPublicKey "ssh-ed25519 ..."',
    )
  }

  // Detect egress IP for 'auto' mode — returns a Result so failures are explicit.
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
  // Use individual SecurityGroupIngressRule / SecurityGroupEgressRule resources
  // rather than inline ingress/egress arrays. This lets Pulumi diff individual
  // rules without replacing the entire Security Group when CIDRs change,
  // avoiding a connectivity outage window on day-2 updates.
  const sg = new aws.ec2.SecurityGroup('clawops-sg', {
    vpcId: vpc.id,
    description: 'clawops managed security group',
    tags: { Name: 'clawops' },
  })

  // One ingress rule per CIDR per port — individually diffable by Pulumi.
  sshIngressCidrs.forEach((cidr, i) => {
    new aws.vpc.SecurityGroupIngressRule(`clawops-sg-ssh-${i}`, {
      securityGroupId: sg.id,
      ipProtocol: 'tcp',
      fromPort: SSH_PORT,
      toPort: SSH_PORT,
      cidrIpv4: cidr,
      tags: { Name: `clawops-ssh-${i}` },
    })
  })

  gatewayIngressCidrs.forEach((cidr, i) => {
    new aws.vpc.SecurityGroupIngressRule(`clawops-sg-gw-${i}`, {
      securityGroupId: sg.id,
      ipProtocol: 'tcp',
      fromPort: GATEWAY_PORT,
      toPort: GATEWAY_PORT,
      cidrIpv4: cidr,
      tags: { Name: `clawops-gateway-${i}` },
    })
  })

  // Single egress rule: allow all outbound.
  new aws.vpc.SecurityGroupEgressRule('clawops-sg-egress', {
    securityGroupId: sg.id,
    ipProtocol: '-1',
    cidrIpv4: '0.0.0.0/0',
    tags: { Name: 'clawops-egress' },
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
    // Least-privilege: only InvokeModel and InvokeModelWithResponseStream.
    // AmazonBedrockFullAccess grants control-plane write actions (CreateCustomModel,
    // DeleteFoundationModel, etc.) that are not needed for inference.
    new aws.iam.RolePolicy('clawops-bedrock-invoke', {
      role: role.name,
      policy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [{
          Effect: 'Allow',
          Action: [
            'bedrock:InvokeModel',
            'bedrock:InvokeModelWithResponseStream',
          ],
          Resource: '*',
        }],
      }),
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
  // Set stack config 'amiId' to pin a specific AMI for plan→apply reproducibility.
  const amiId = pinnedAmiId ?? (await aws.ec2.getAmi({
    mostRecent: true,
    owners: ['099720109477'], // Canonical
    filters: [
      { name: 'name', values: ['ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*'] },
      { name: 'virtualization-type', values: ['hvm'] },
    ],
  })).id
  process.stderr.write(`[clawops] Using AMI: ${amiId}\n`)

  // --- EC2 Instance ---
  const instance = new aws.ec2.Instance('clawops-instance', {
    ami: amiId,
    instanceType,
    subnetId: subnet.id,
    vpcSecurityGroupIds: [sg.id],
    iamInstanceProfile: instanceProfile.name,
    keyName: keyPair.keyName,
    userData: makeStartupScript({ openclawVersion, os: 'ubuntu', bedrockEnabled }),
    // IMDSv2 with hopLimit=2 so Docker containers on this host can reach IMDS
    // and obtain the instance role credentials (required for Bedrock access).
    metadataOptions: {
      httpTokens: 'required',
      httpPutResponseHopLimit: 2,
    },
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
