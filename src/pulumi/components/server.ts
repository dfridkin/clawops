// Pulumi ComponentResource: Server — provisions the VM host for a clawops stack.
// URN: clawops:infra:Server
//
// NOTE: Cloud-specific resources (EC2, GCE, Azure VM) are currently created
// inline in each provider program (src/providers/*/program.ts). This component
// defines the canonical interface; providers should migrate to use it.

import * as pulumi from '@pulumi/pulumi'

export interface ServerArgs {
  /** Normalized instance type (e.g. 't3.small', 'e2-small', 'Standard_B1s'). */
  instanceType: pulumi.Input<string>
  /** Cloud region. */
  region: pulumi.Input<string>
  /** SSH public key content (not a path). */
  sshPublicKey: pulumi.Input<string>
  /** OS image identifier (AMI ID, GCE image, Azure urn). */
  imageId: pulumi.Input<string>
  /** Security group / firewall resource IDs to attach. */
  securityGroupIds?: pulumi.Input<pulumi.Input<string>[]>
  tags?: pulumi.Input<Record<string, pulumi.Input<string>>>
}

export class Server extends pulumi.ComponentResource {
  /** Provider-specific resource ID (EC2 instance ID, GCE self-link, Azure resource ID). */
  public readonly instanceId: pulumi.Output<string>
  /** Public IP address of the provisioned VM. */
  public readonly publicIp: pulumi.Output<string>
  /** Hostname to use for SSH connections (same as publicIp for cloud VMs). */
  public readonly sshHost: pulumi.Output<string>

  constructor(name: string, args: ServerArgs, opts?: pulumi.ComponentResourceOptions) {
    super('clawops:infra:Server', name, {}, opts)

    // Placeholder outputs — providers override these via their inline programs
    // until they migrate to instantiate this component.
    this.instanceId = pulumi.output(args.imageId).apply(() => `${name}-instance`)
    this.publicIp = pulumi.output(args.region).apply(() => '0.0.0.0')
    this.sshHost = this.publicIp

    this.registerOutputs({
      instanceId: this.instanceId,
      publicIp: this.publicIp,
      sshHost: this.sshHost,
    })
  }
}
