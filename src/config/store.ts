// ~/.clawops/config.json management — not yet implemented (M1).
// Per R6: no secrets stored here.

export interface CredentialsRef {
  source: 'env' | 'cli-profile' | 'file' | 'instance-metadata'
  envVars?: string[]
  profileName?: string
}

export interface StackConfig {
  provider: string
  stateUrl: string
  region?: string
  credentialsRef: CredentialsRef
}

export interface ClawopsConfig {
  version: 1
  defaults: {
    stack: string
    provider: string
  }
  stacks: Record<string, StackConfig>
  ssh: {
    keyPath: string
    knownHostsPath: string
  }
  mcp: {
    auditLogPath: string
  }
}

export function getConfig(): ClawopsConfig {
  throw new Error('config store: not yet implemented (M1)')
}

export function writeConfig(_config: ClawopsConfig): void {
  throw new Error('config store: not yet implemented (M1)')
}
