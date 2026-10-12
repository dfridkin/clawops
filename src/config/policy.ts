// The operator's spending policy: which instance types clawops may deploy, and how many stacks
// it may manage. WO-62 precondition 1, and useful without it.
//
// It lives in ~/.clawops/config.json, not in the deploy plan. A plan is what an agent writes, so
// a limit carried in the plan is set by the party it is meant to limit. No MCP tool writes this
// block; the operator sets it with `clawops setup` or by editing the file.
//
// One module, called by plan generation, apply and init, so the CLI and every MCP tool that
// deploys refuse the same things in the same words.

import path from 'node:path'
import { UsageError } from '../errors/index.js'
import { getConfigDir, type ClawopsConfig } from './store.js'

export { PolicySchema, type Policy } from './policy-schema.js'
import type { Policy } from './policy-schema.js'

function configFile(): string {
  return path.join(getConfigDir(), 'config.json')
}

/** The allowlist for one provider, normalised to provider-native types; undefined = no limit. */
export async function allowedTypesFor(
  policy: Policy | undefined,
  provider: string,
): Promise<string[] | undefined> {
  const entries = policy?.allowedInstanceTypes?.[provider]
  if (!entries) return undefined
  // A clawops size is mapped the way plan generation maps it; a native type is kept as written.
  const { nativeInstanceType } = await import('../plan/generate.js')
  return [...new Set(await Promise.all(entries.map((e) => nativeInstanceType(provider, e))))]
}

/**
 * Refuse an instance type the policy does not allow. `instanceType` is the provider-native type,
 * as it will reach the cloud.
 */
export async function enforceInstanceType(
  config: ClawopsConfig | null,
  provider: string,
  instanceType: string,
): Promise<void> {
  const allowed = await allowedTypesFor(config?.policy, provider)
  if (!allowed) return
  const { nativeInstanceType } = await import('../plan/generate.js')
  if (allowed.includes(await nativeInstanceType(provider, instanceType))) return
  throw new UsageError(
    `Instance type "${instanceType}" is not allowed on ${provider} by this machine's spending ` +
      `policy (${configFile()} → policy.allowedInstanceTypes.${provider}). Allowed: ` +
      `${allowed.join(', ')}. The operator can change it with \`clawops setup\` or by editing ` +
      'that file.',
  )
}

/**
 * Refuse a new stack beyond the cap. Re-registering a stack that already exists does not count:
 * it adds nothing.
 */
export function stackCapRefusal(config: ClawopsConfig | null, stackName: string): string | undefined {
  const max = config?.policy?.maxStacks
  if (!max || !config) return undefined
  const names = Object.keys(config.stacks)
  if (names.includes(stackName) || names.length < max) return undefined
  return (
    `This machine's spending policy allows ${max} stack${max === 1 ? '' : 's'} ` +
    `(${configFile()} → policy.maxStacks), and ${names.length} exist: ${names.join(', ')}. ` +
    'Remove one with `clawops stacks delete` after destroying it, or the operator can raise the ' +
    'cap with `clawops setup`.'
  )
}
