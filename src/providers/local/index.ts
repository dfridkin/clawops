// Local provider adapter — SSH bootstrap, no Pulumi, file:// state.

import { accessSync } from 'node:fs'
import type {
  ProviderAdapter,
  ProviderName,
  InstanceAlias,
  ConnectionInfo,
  StackOutputs,
  ValidationResult,
  PulumiFn,
} from '../types.js'

const localAdapter: ProviderAdapter = {
  name: 'local' as ProviderName,

  /** Never called — local stacks bypass Pulumi entirely. */
  get program(): PulumiFn {
    return async () => ({})
  },

  getConnectionInfo(outputs: StackOutputs): ConnectionInfo {
    return {
      host: String(outputs['sshHost'] ?? ''),
      port: Number(outputs['sshPort'] ?? 22),
      user: String(outputs['sshUser'] ?? 'root'),
      privateKeyPath: String(outputs['privateKeyPath'] ?? ''),
      knownHostsPath: String(outputs['knownHostsPath'] ?? ''),
    }
  },

  normalizeInstanceType(_alias: InstanceAlias): string {
    return 'local'
  },

  defaultRegion(): string {
    return 'local'
  },

  stateBackendUrl(_bucket: string): string {
    return 'file://~/.clawops/state'
  },

  async validateConfig(): Promise<ValidationResult> {
    // For local, credentials = the SSH private key. Checked at bootstrap time
    // when we have the actual keyPath in hand. Nothing to validate globally here.
    const keyPath = process.env['CLAWOPS_SSH_KEY_PATH']
    if (keyPath) {
      try {
        accessSync(keyPath)
      } catch {
        return {
          ok: false,
          errors: [`SSH key not readable: ${keyPath}`],
        }
      }
    }
    return { ok: true, errors: [] }
  },
}

export default localAdapter
