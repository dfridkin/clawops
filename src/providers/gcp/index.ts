// GCP provider adapter — implements ProviderAdapter for Google Cloud Platform.

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
import { gcpProgram } from './program.js'

const INSTANCE_TYPE_MAP: Record<InstanceAlias, string> = {
  micro: 'e2-micro',
  small: 'e2-standard-2',
  medium: 'e2-standard-4',
  large: 'e2-standard-8',
  gpu: 'n1-standard-4', // TODO M3: add accelerator config for GPU instances
}

const gcpAdapter: ProviderAdapter = {
  name: 'gcp' as ProviderName,

  get program(): PulumiFn {
    return gcpProgram
  },

  getConnectionInfo(outputs: StackOutputs): ConnectionInfo {
    return {
      host: String(outputs['sshHost']),
      port: Number(outputs['sshPort']),
      user: String(outputs['sshUser']),
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
    return 'us-central1'
  },

  stateBackendUrl(bucket: string): string {
    return `gs://${bucket}`
  },

  async validateConfig(): Promise<ValidationResult> {
    const errors: string[] = []

    const hasKeyFile = Boolean(process.env['GOOGLE_APPLICATION_CREDENTIALS'])
    const hasUserCreds = Boolean(process.env['CLOUDSDK_AUTH_ACCESS_TOKEN'])

    if (!hasKeyFile && !hasUserCreds) {
      // Check if running on GCP instance metadata server (ADC via instance metadata)
      const onGcp = await checkInstanceMetadata()
      if (!onGcp) {
        errors.push(
          'No GCP credentials found. ' +
            'Set GOOGLE_APPLICATION_CREDENTIALS to a service account key file, ' +
            'or run `gcloud auth application-default login`.',
        )
      }
    }

    return { ok: errors.length === 0, errors }
  },
}

async function checkInstanceMetadata(): Promise<boolean> {
  try {
    const res = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/instance/id',
      {
        headers: { 'Metadata-Flavor': 'Google' },
        signal: AbortSignal.timeout(1_000),
      },
    )
    return res.ok
  } catch {
    return false
  }
}

export default gcpAdapter
