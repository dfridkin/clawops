// StackOutputs type + extractor from raw Pulumi output map.

import type { BaseStackOutputs } from '../providers/types.js'
import { StateError } from '../errors/index.js'

export type { BaseStackOutputs }

/**
 * Extract typed BaseStackOutputs from a raw Pulumi stack output record.
 * Throws StateError if required fields are missing or malformed.
 */
export function extractBaseOutputs(raw: Record<string, unknown>): BaseStackOutputs {
  const required = [
    'instanceId',
    'publicIp',
    'gatewayUrl',
    'sshHost',
    'sshPort',
    'sshUser',
    'region',
    'provisionedAt',
  ] as const

  for (const key of required) {
    if (raw[key] === undefined || raw[key] === null) {
      throw new StateError(
        `Stack output is missing required field "${key}". ` +
          'The stack may need to be re-deployed with `clawops up`.',
      )
    }
  }

  return {
    instanceId: String(raw['instanceId']),
    publicIp: String(raw['publicIp']),
    gatewayUrl: String(raw['gatewayUrl']),
    sshHost: String(raw['sshHost']),
    sshPort: Number(raw['sshPort']),
    sshUser: String(raw['sshUser']),
    region: String(raw['region']),
    provisionedAt: String(raw['provisionedAt']),
  }
}
