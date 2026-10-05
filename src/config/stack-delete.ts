// Forgetting a stack: removing it from ~/.clawops/config.json.
//
// Shared by `clawops stacks delete` and the clawops_stacks_delete MCP tool, so the two cannot
// drift in what they refuse — the refusals are the feature. Nothing here prints, prompts or
// exits: the CLI throws and renders at its boundary, the MCP server elicits and returns text
// (R15 forbids a stdio server writing a byte to stdout).
//
// Deleting a stack from config never touches its infrastructure. That is why a stack that is
// still deployed is refused unless forced: once it is forgotten, clawops can no longer see the
// resources it leaves running.

import { requireConfig, setConfig } from './store.js'

export type StackDeleteRefusal = 'not-found' | 'only-stack' | 'default' | 'deployed'

export type StackDeleteCheck =
  | {
      ok: true
      name: string
      /** True when the stack is the configured default (only reachable with `force`). */
      isDefault: boolean
      /** Things the caller should tell the user, e.g. that deployment status was unverifiable. */
      warnings: string[]
    }
  | { ok: false; refusal: StackDeleteRefusal; reason: string }

/** What a successful deletion should always be accompanied by. Same words on both surfaces. */
export function forgetNotice(name: string): string {
  return (
    `This removes "${name}" from clawops config only. ` +
    'Cloud resources are NOT destroyed. ' +
    'Run `clawops destroy --stack ' + name + '` first if you want to remove cloud resources.'
  )
}

/**
 * Decide whether `name` may be forgotten.
 *
 * `force` skips exactly what `--force` skips on the CLI: the default-stack refusal and the
 * still-deployed check. It never skips "not found" or "only remaining stack".
 */
export async function checkStackDelete(
  name: string,
  opts: { force: boolean },
): Promise<StackDeleteCheck> {
  const config = requireConfig()

  if (!(name in config.stacks)) {
    return { ok: false, refusal: 'not-found', reason: `Stack "${name}" not found in config.` }
  }

  if (Object.keys(config.stacks).length === 1) {
    return {
      ok: false,
      refusal: 'only-stack',
      reason:
        `Cannot delete the only remaining stack "${name}". ` +
        'Add another stack first or run `clawops destroy` to tear down resources.',
    }
  }

  const isDefault = name === config.defaults.stack
  if (isDefault && !opts.force) {
    return {
      ok: false,
      refusal: 'default',
      reason:
        `"${name}" is the default stack. Use --force to delete it ` +
        '(clawops will switch the default to another stack).',
    }
  }

  const warnings: string[] = []
  if (!opts.force) {
    let isDeployed = false
    try {
      isDeployed = await isStackDeployed(name)
    } catch {
      warnings.push(`Could not verify deployment status for "${name}" — proceeding anyway.`)
    }
    if (isDeployed) {
      return {
        ok: false,
        refusal: 'deployed',
        reason:
          `Stack "${name}" is still deployed. ` +
          `Run \`clawops down --stack ${name}\` first to destroy cloud resources, ` +
          'or pass --force to remove from registry only.',
      }
    }
  }

  return { ok: true, name, isDefault, warnings }
}

/** Local stacks are deployed when they have local state; cloud stacks when they have a public IP. */
async function isStackDeployed(name: string): Promise<boolean> {
  const { buildContext } = await import('../cli/context.js')
  const ctx = buildContext({ stack: name })
  if (ctx.adapter.name === 'local') return !!ctx.localState
  const stack = await ctx.getStack()
  const outputMap = await stack.outputs()
  const outputs = Object.fromEntries(
    Object.entries(outputMap).map(([k, v]) => [k, (v as { value: unknown }).value]),
  )
  return !!outputs['publicIp']
}

export interface StackDeleted {
  name: string
  message: string
  /** Set when the deleted stack was the default; the stack that replaced it. */
  newDefault?: string
  newDefaultMessage?: string
}

/**
 * Remove `name` from config. Call only after `checkStackDelete` returned ok and the caller has
 * confirmed. If it was the default, the first remaining stack becomes the default.
 */
export function deleteStackFromConfig(name: string): StackDeleted {
  const config = requireConfig()
  const newStacks = { ...config.stacks }
  delete newStacks[name]
  const updated = { ...config, stacks: newStacks }

  const wasDefault = name === config.defaults.stack
  if (wasDefault) {
    updated.defaults = { ...config.defaults, stack: Object.keys(newStacks)[0]! }
  }

  setConfig(updated)

  const result: StackDeleted = { name, message: `Stack "${name}" removed from config.` }
  if (wasDefault) {
    result.newDefault = updated.defaults.stack
    result.newDefaultMessage = `Default stack switched to "${updated.defaults.stack}".`
  }
  return result
}
