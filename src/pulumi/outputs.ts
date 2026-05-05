// StackOutputs type + extractors — not yet implemented (M1).

import type { BaseStackOutputs } from '../providers/types'

export type { BaseStackOutputs }

/** Extract typed outputs from a raw Pulumi stack output record. */
export function extractBaseOutputs(
  _raw: Record<string, unknown>,
): BaseStackOutputs {
  throw new Error('pulumi outputs: not yet implemented (M1)')
}
