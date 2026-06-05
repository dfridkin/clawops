// Pulumi ComponentResource: Secrets / ConfigStore — stores the gateway token in
// the provider's managed secret service (SSM, Secret Manager, Key Vault).
// URN: clawops:state:Secrets
//
// Each provider program instantiates this after provisioning the server so that
// the gateway token is stored securely and the instance can retrieve it at boot.

import * as pulumi from '@pulumi/pulumi'

export type SecretBackend = 'aws-ssm' | 'gcp-sm' | 'azure-kv' | 'none'

export interface SecretsArgs {
  /** The backend to write secrets into. */
  backend: pulumi.Input<SecretBackend>
  /** Stack name used as a namespace prefix. */
  stackName: pulumi.Input<string>
  /** The OpenClaw gateway auth token value. */
  gatewayToken: pulumi.Input<string>
  /** Cloud region (required for AWS SSM and Azure Key Vault). */
  region?: pulumi.Input<string>
  /** Resource ID of an existing KMS key / Key Vault for encryption (optional). */
  kmsKeyId?: pulumi.Input<string>
}

export class Secrets extends pulumi.ComponentResource {
  /**
   * Provider-specific ARN, resource name, or secret ID of the stored gateway
   * token. Providers pass this to the instance via user-data or metadata so the
   * gateway can retrieve the token at boot.
   */
  public readonly gatewayTokenRef: pulumi.Output<string>

  constructor(name: string, args: SecretsArgs, opts?: pulumi.ComponentResourceOptions) {
    super('clawops:state:Secrets', name, {}, opts)

    // The concrete secret resource is created by each provider program because
    // the SDK import (@pulumi/aws, @pulumi/gcp, @pulumi/azure-native) differs per
    // provider. This component establishes the shared interface and URN convention;
    // provider programs set gatewayTokenRef on the options object passed back here.
    this.gatewayTokenRef = pulumi.output(args.stackName).apply(
      (stack) => `clawops/${stack}/gateway-token`,
    )

    this.registerOutputs({ gatewayTokenRef: this.gatewayTokenRef })
  }
}
