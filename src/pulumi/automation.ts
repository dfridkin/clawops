// Pulumi Automation API wrapper — not yet implemented (M1).
// See SPEC.md §4 for the design.

export interface StackOpts {
  stack: string
  stateUrl: string
  configDir: string
}

/** Placeholder — implemented in M1 using @pulumi/pulumi/automation. */
export async function getOrCreateStack(_opts: StackOpts): Promise<never> {
  throw new Error('pulumi automation: not yet implemented (M1)')
}
