// The instance types clawops' aliases mean on AWS.
//
// Its own module so the preflight can check them without importing the adapter, which imports
// the preflight — the same shape as the Azure size table.

import type { InstanceAlias } from '../types.js'

export const INSTANCE_TYPE_MAP: Record<InstanceAlias, string> = {
  micro:  't3.micro',
  small:  't3.small',
  medium: 't3.medium',
  large:  't3.large',
  gpu:    'g4dn.xlarge',
}

/** The size a plan gets when nobody says otherwise — the one worth checking hardest. */
export const DEFAULT_ALIAS: InstanceAlias = 'small'
