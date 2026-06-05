// Pulumi ComponentResource: Gateway — deploys the OpenClaw container on the server.
// URN: clawops:app:Gateway
//
// Runs the openclaw Docker image on the target server via a remote exec resource.
// Providers instantiate this after the Server component has provisioned the host.

import * as pulumi from '@pulumi/pulumi'
import * as command from '@pulumi/command'

const GATEWAY_PORT = 18789

export interface GatewayArgs {
  /** Public IP of the server where OpenClaw will be deployed. */
  serverIp: pulumi.Input<string>
  /** SSH connection details for the remote exec resource. */
  connection: pulumi.Input<command.types.input.remote.ConnectionArgs>
  /** OpenClaw release tag or 'latest'. */
  openclawVersion: pulumi.Input<string>
  /**
   * Hash of the openclaw.json config overlay; changing it forces a container
   * restart even when the image tag hasn't changed.
   */
  configHash: pulumi.Input<string>
}

export class Gateway extends pulumi.ComponentResource {
  /** Docker container ID on the remote host. */
  public readonly containerId: pulumi.Output<string>
  /** Gateway URL reachable from the outside. */
  public readonly gatewayUrl: pulumi.Output<string>

  constructor(name: string, args: GatewayArgs, opts?: pulumi.ComponentResourceOptions) {
    super('clawops:app:Gateway', name, {}, opts)

    const run = new command.remote.Command(
      `${name}-run`,
      {
        connection: args.connection,
        // Pull and (re)start the container; --pull always ensures the tag is fresh.
        create: pulumi.interpolate`docker run -d --name openclaw --restart unless-stopped \
  -p ${GATEWAY_PORT}:${GATEWAY_PORT} \
  ghcr.io/anthropics/openclaw:${args.openclawVersion} 2>&1 || \
  docker start openclaw`,
        // On update, stop + remove the old container so the create command runs cleanly.
        update: pulumi.interpolate`docker rm -f openclaw 2>/dev/null; \
  docker run -d --name openclaw --restart unless-stopped \
  -p ${GATEWAY_PORT}:${GATEWAY_PORT} \
  ghcr.io/anthropics/openclaw:${args.openclawVersion} 2>&1`,
        delete: 'docker rm -f openclaw 2>/dev/null; true',
        // Trigger replacement when config changes.
        triggers: [args.configHash, args.openclawVersion],
      },
      { parent: this },
    )

    this.containerId = run.stdout.apply((out) => out.trim() || `${name}-container`)
    this.gatewayUrl = pulumi.interpolate`https://${args.serverIp}:${GATEWAY_PORT}`

    this.registerOutputs({
      containerId: this.containerId,
      gatewayUrl: this.gatewayUrl,
    })
  }
}
