// The shape of the spending policy block. Its own module, with no imports from the config store,
// so that store.ts can include it without an import cycle. Behaviour is in ./policy.ts.

import { z } from 'zod'

export const PolicySchema = z.object({
  /**
   * Per provider, the instance types clawops may deploy. A clawops size (`micro`, `small`,
   * `medium`, `large`) or a provider-native type; sizes are compared after the provider maps
   * them, so `small` and `t3.small` are the same entry on AWS. A provider with no entry is
   * unrestricted.
   */
  allowedInstanceTypes: z.record(z.array(z.string()).min(1)).optional(),
  /** How many stacks this config may hold. Absent = no cap. */
  maxStacks: z.number().int().positive().optional(),
})

export type Policy = z.infer<typeof PolicySchema>
