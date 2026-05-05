// Maker plan generation — not yet implemented (M6).
// Output is validated against spec/deploy-plan.schema.json.

export interface DeployPlan {
  apiVersion: 'clawops.dev/v1'
  kind: 'DeployPlan'
  metadata: {
    name: string
    generatedAt: string
    generator?: string
    generatorVersion?: string
    labels?: Record<string, string>
  }
  spec: {
    provider: 'aws' | 'gcp' | 'azure' | 'local'
    region?: string
    stackName: string
    instanceType: string
    openclaw: {
      version: string
      config?: Record<string, unknown>
      channels?: string[]
    }
    secrets?: Array<{
      name: string
      source: 'env' | 'aws-sm' | 'aws-ssm' | 'gcp-sm' | 'azure-kv' | 'file'
      ref?: string
    }>
    network: {
      allowedSshCidrs: string[]
      allowedGatewayCidrs: string[]
      tailscale?: { enabled: boolean; authKeyRef?: string }
    }
    ssh?: { publicKey?: string; user?: string }
    tags?: Record<string, string>
  }
  diff?: unknown
}

export async function generatePlan(_intent: Record<string, unknown>): Promise<DeployPlan> {
  throw new Error('plan generation: not yet implemented (M6)')
}
