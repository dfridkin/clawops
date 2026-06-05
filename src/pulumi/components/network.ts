// Pulumi ComponentResource: Network / Firewall — deny-all default with explicit allows.
// URN: clawops:net:Firewall
//
// NOTE: Firewall rules are currently created inline in provider programs.
// This component defines the canonical interface; providers should migrate to use it.

import * as pulumi from '@pulumi/pulumi'

export interface NetworkArgs {
  /** CIDRs permitted to reach the SSH port. Empty = deny all. */
  allowedSshCidrs: pulumi.Input<pulumi.Input<string>[]>
  /** CIDRs permitted to reach the gateway port (18789). Empty = deny all. */
  allowedGatewayCidrs: pulumi.Input<pulumi.Input<string>[]>
  /** SSH port. Defaults to 22. */
  sshPort?: pulumi.Input<number>
  /** Gateway port. Defaults to 18789. */
  gatewayPort?: pulumi.Input<number>
  tags?: pulumi.Input<Record<string, pulumi.Input<string>>>
}

export class Network extends pulumi.ComponentResource {
  /** Provider-specific firewall / security-group resource IDs. */
  public readonly resourceIds: pulumi.Output<string[]>
  /** Effective SSH CIDRs applied (after resolution of 'auto' mode). */
  public readonly sshCidrs: pulumi.Output<string[]>
  /** Effective gateway CIDRs applied. */
  public readonly gatewayCidrs: pulumi.Output<string[]>

  constructor(name: string, args: NetworkArgs, opts?: pulumi.ComponentResourceOptions) {
    super('clawops:net:Firewall', name, {}, opts)

    this.resourceIds = pulumi.output(args.allowedSshCidrs).apply(() => [`${name}-firewall`])
    this.sshCidrs = pulumi.output(args.allowedSshCidrs) as pulumi.Output<string[]>
    this.gatewayCidrs = pulumi.output(args.allowedGatewayCidrs) as pulumi.Output<string[]>

    this.registerOutputs({
      resourceIds: this.resourceIds,
      sshCidrs: this.sshCidrs,
      gatewayCidrs: this.gatewayCidrs,
    })
  }
}
