// AWS provider adapter — implements ProviderAdapter for Amazon Web Services.

import process from 'node:process'
import type {
  ProviderAdapter,
  ProviderName,
  InstanceAlias,
  ConnectionInfo,
  StackOutputs,
  ValidationResult,
  PulumiFn,
} from '../types.js'
import { awsProgram } from './program.js'

const INSTANCE_TYPE_MAP: Record<InstanceAlias, string> = {
  micro:  't3.micro',
  small:  't3.small',
  medium: 't3.medium',
  large:  't3.large',
  gpu:    'g4dn.xlarge',
}

const awsAdapter: ProviderAdapter = {
  name: 'aws' as ProviderName,

  get program(): PulumiFn {
    return awsProgram
  },

  getConnectionInfo(outputs: StackOutputs): ConnectionInfo {
    return {
      host: String(outputs['sshHost'] ?? ''),
      port: Number(outputs['sshPort'] ?? 22),
      user: String(outputs['sshUser'] ?? 'ubuntu'),
      privateKeyPath: String(outputs['privateKeyPath'] ?? ''),
      knownHostsPath: String(outputs['knownHostsPath'] ?? ''),
    }
  },

  normalizeInstanceType(alias: InstanceAlias): string {
    const mapped = INSTANCE_TYPE_MAP[alias]
    if (!mapped) throw new Error(`Unknown instance alias: ${alias}`)
    return mapped
  },

  defaultRegion(): string {
    return 'us-east-1'
  },

  stateBackendUrl(bucket: string): string {
    return `s3://${bucket}`
  },

  async validateConfig(): Promise<ValidationResult> {
    const errors: string[] = []

    const hasProfile  = Boolean(process.env['AWS_PROFILE'])
    const hasKeyId    = Boolean(process.env['AWS_ACCESS_KEY_ID'])
    const hasOidc     = Boolean(process.env['AWS_ROLE_ARN'] && process.env['AWS_WEB_IDENTITY_TOKEN_FILE'])

    if (!hasProfile && !hasKeyId && !hasOidc) {
      const onAws = await checkImds()
      if (!onAws) {
        errors.push(
          'No AWS credentials found. ' +
          'Set AWS_PROFILE, AWS_ACCESS_KEY_ID, or AWS_ROLE_ARN + AWS_WEB_IDENTITY_TOKEN_FILE, ' +
          'or run on an EC2 instance with an IAM instance role.',
        )
      }
    }

    return { ok: errors.length === 0, errors }
  },
}

async function checkImds(): Promise<boolean> {
  try {
    const res = await fetch(
      'http://169.254.169.254/latest/meta-data/instance-id',
      { signal: AbortSignal.timeout(1_000) },
    )
    return res.ok
  } catch {
    return false
  }
}

export default awsAdapter
