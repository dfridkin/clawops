// The setup wizard's spending-limits step: which server sizes clawops may deploy on a provider,
// and how many deployments it may manage. Most CLI users meet clawops through the wizard, so the
// policy in ./../config/policy.ts is set here as well as by editing ~/.clawops/config.json.
//
// Kept out of setup.ts so it can be tested without driving the whole wizard.

import type { Policy } from '../config/policy-schema.js'

type Choice = { name: string; value: string }

/** The subset of an inquirer question this step uses; setup.ts's wider shim satisfies it. */
interface PolicyQuestion {
  type: 'confirm' | 'checkbox' | 'input'
  name: string
  message: string
  choices?: Array<{ name: string; value: unknown; checked?: boolean }>
  default?: unknown
  validate?: (v: string) => boolean | string
}

interface Prompter {
  prompt<T>(questions: PolicyQuestion[]): Promise<T>
}

/** The sizes the policy allows on this provider, as wizard choices. No policy = all of them. */
export async function allowedChoices(
  provider: string,
  choices: Choice[],
  policy: Policy | undefined,
): Promise<Choice[]> {
  const { allowedTypesFor } = await import('../config/policy.js')
  const allowed = await allowedTypesFor(policy, provider)
  if (!allowed) return choices
  const { nativeInstanceType } = await import('../plan/generate.js')
  const kept: Choice[] = []
  for (const c of choices) {
    if (allowed.includes(await nativeInstanceType(provider, c.value))) kept.push(c)
  }
  // A provider-native type in the allowlist that is not one of the clawops sizes still has to be
  // choosable, or the wizard would offer nothing the policy permits.
  const offered = new Set(await Promise.all(kept.map((c) => nativeInstanceType(provider, c.value))))
  for (const t of allowed) if (!offered.has(t)) kept.push({ name: `${t} (allowed by policy)`, value: t })
  return kept
}

function describe(provider: string, policy: Policy | undefined): string {
  const sizes = policy?.allowedInstanceTypes?.[provider]
  const cap = policy?.maxStacks
  return (
    `Server sizes on ${provider}: ${sizes ? sizes.join(', ') : 'any'}. ` +
    `Deployments: ${cap ? `at most ${cap}` : 'no limit'}.`
  )
}

/**
 * Ask whether to change the spending limits, and if so, which. Returns the new policy, or
 * undefined when the operator kept what they had.
 *
 * `provider` is undefined for a local deployment, where there are no server sizes to limit and
 * only the deployment cap applies.
 */
export async function promptSpendingPolicy(opts: {
  provider: string | undefined
  choices: Choice[]
  current: Policy | undefined
  stackCount: number
  inquirer: Prompter
}): Promise<Policy | undefined> {
  const { provider, choices, current, stackCount, inquirer } = opts
  const { change } = await inquirer.prompt<{ change: boolean }>([{
    type: 'confirm',
    name: 'change',
    message:
      `Spending limits — ${describe(provider ?? 'this machine', current)} ` +
      'Change them? (they apply to every deploy from this machine, by any tool)',
    default: false,
  }])
  if (!change) return undefined

  const next: Policy = { ...(current ?? {}) }

  if (provider && choices.length > 0) {
    const currentSizes = current?.allowedInstanceTypes?.[provider]
    const { sizes } = await inquirer.prompt<{ sizes: string[] }>([{
      type: 'checkbox',
      name: 'sizes',
      message: `Server sizes clawops may deploy on ${provider}: (space to toggle; all checked = no limit)`,
      choices: choices.map((c) => ({
        ...c,
        checked: currentSizes ? currentSizes.includes(c.value) : true,
      })),
      // A checkbox answer is the array of checked values, whatever the shim's signature says.
      validate: (v: string) =>
        (Array.isArray(v as unknown) && (v as unknown as unknown[]).length > 0) || 'Allow at least one size.',
    }])
    const all = sizes.length === choices.length
    const rest = { ...(next.allowedInstanceTypes ?? {}) }
    if (all) delete rest[provider]
    else rest[provider] = sizes
    if (Object.keys(rest).length > 0) next.allowedInstanceTypes = rest
    else delete next.allowedInstanceTypes
  }

  const { maxStacks } = await inquirer.prompt<{ maxStacks: string }>([{
    type: 'input',
    name: 'maxStacks',
    message: 'Most deployments clawops may manage: (a number, or leave blank for no limit)',
    default: current?.maxStacks ? String(current.maxStacks) : '',
    validate: (v: string) =>
      v.trim() === '' || (/^\d+$/.test(v.trim()) && Number(v) > 0) || 'A whole number above 0, or blank.',
  }])
  if (maxStacks.trim() === '') delete next.maxStacks
  else {
    next.maxStacks = Number(maxStacks)
    if (next.maxStacks <= stackCount) {
      process.stderr.write(
        `[clawops] note: ${stackCount} deployment${stackCount === 1 ? ' exists' : 's exist'} ` +
          'already, so new ones will be refused until some are removed.\n',
      )
    }
  }
  return next
}

/**
 * Save the policy into ~/.clawops/config.json. Returns false when there is no config file yet; the
 * wizard calls it again once the deployment has been registered.
 */
export async function savePolicy(policy: Policy): Promise<boolean> {
  const { getConfig, setConfig } = await import('../config/store.js')
  const config = getConfig()
  if (!config) return false
  const { allowedInstanceTypes, maxStacks } = policy
  const cleaned: Policy = {
    ...(allowedInstanceTypes && Object.keys(allowedInstanceTypes).length > 0 ? { allowedInstanceTypes } : {}),
    ...(maxStacks ? { maxStacks } : {}),
  }
  const next = { ...config }
  if (Object.keys(cleaned).length > 0) next.policy = cleaned
  else delete next.policy
  setConfig(next)
  return true
}
