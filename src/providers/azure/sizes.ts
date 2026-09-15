// The VM sizes clawops' aliases mean on Azure.
//
// Its own module so the preflight can check these against what a subscription is actually
// offered without importing the adapter, which imports the preflight.
//
// No static map is right everywhere: Azure offers SKU families per subscription and region, and
// a new subscription is commonly offered none of the B series in a major region — the map below
// resolved to nothing deployable in `eastus` on the subscription this was first run against.
// The preflight names what is available rather than this file guessing.

import type { InstanceAlias } from '../types.js'

export const INSTANCE_TYPE_MAP: Record<InstanceAlias, string> = {
  micro:  'Standard_B1s',
  small:  'Standard_B2s',
  medium: 'Standard_B4ms',
  large:  'Standard_B8ms',
  gpu:    'Standard_NC6s_v3',
}

/** The size a plan gets when nobody says otherwise — the one worth checking hardest. */
export const DEFAULT_ALIAS: InstanceAlias = 'small'
