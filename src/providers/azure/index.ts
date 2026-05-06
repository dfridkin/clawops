// Azure provider adapter — implements ProviderAdapter for Microsoft Azure.

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
import { azureProgram } from './program.js'

const INSTANCE_TYPE_MAP: Record<InstanceAlias, string> = {
  micro:  'Standard_B1s',
  small:  'Standard_B2s',
  medium: 'Standard_B4ms',
  large:  'Standard_B8ms',
  gpu:    'Standard_NC6s_v3',
}

const azureAdapter: ProviderAdapter = {
  name: 'azure' as ProviderName,

  get program(): PulumiFn {
    return azureProgram
  },

  getConnectionInfo(outputs: StackOutputs): ConnectionInfo {
    return {
      host: String(outputs['sshHost'] ?? ''),
      port: Number(outputs['sshPort'] ?? 22),
      user: String(outputs['sshUser'] ?? 'clawops'),
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
    return 'eastus'
  },

  stateBackendUrl(bucket: string): string {
    return `azblob://${bucket}`
  },

  async validateConfig(): Promise<ValidationResult> {
    const errors: string[] = []

    const clientId   = process.env['AZURE_CLIENT_ID']
    const tenantId   = process.env['AZURE_TENANT_ID']
    const clientSecret = process.env['AZURE_CLIENT_SECRET']
    const federatedToken = process.env['AZURE_FEDERATED_TOKEN_FILE']

    const hasServicePrincipal = Boolean(clientId && tenantId && clientSecret)
    const hasOidc = Boolean(clientId && tenantId && federatedToken)

    if (!hasServicePrincipal && !hasOidc) {
      const onAzure = await checkImds()
      if (!onAzure) {
        errors.push(
          'No Azure credentials found. ' +
          'Set AZURE_CLIENT_ID + AZURE_TENANT_ID + AZURE_CLIENT_SECRET (service principal), ' +
          'or AZURE_CLIENT_ID + AZURE_TENANT_ID + AZURE_FEDERATED_TOKEN_FILE (OIDC), ' +
          'or run on an Azure VM with a managed identity.',
        )
      }
    }

    return { ok: errors.length === 0, errors }
  },
}

async function checkImds(): Promise<boolean> {
  try {
    const res = await fetch(
      'http://169.254.169.254/metadata/instance?api-version=2021-02-01',
      {
        headers: { Metadata: 'true' },
        signal: AbortSignal.timeout(1_000),
      },
    )
    return res.ok
  } catch {
    return false
  }
}

export default azureAdapter
