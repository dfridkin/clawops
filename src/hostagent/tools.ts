// Which tools a host agent gets, and what happens when it calls a destructive one — ADR 0014.
//
// Three kinds of tool, decided here and nowhere else:
//
//   read       Served, unchanged apart from config_get redaction. The read toolset after the
//              disclosure review, less what needs the operator's machine.
//   handoff    Served only if the operator allowed it at install. Changes nothing; returns the
//              CLI command for the operator to run (§2).
//   refused    Never served. Self-targeting operations (§4), and everything that needs Pulumi,
//              cloud credentials or the operator's clawops config.

import { TOOLSETS } from '../mcp/tools/_generated.js'

/**
 * The read toolset, less three tools that need the operator's machine. `secret_list` and
 * `secret_audit` read the clawops secret store, which is on the operator's machine, and
 * `clawops_plan` needs their config and Pulumi state (ADR 0014, revised 2026-10-16).
 */
const NOT_ON_HOST = new Set(['clawops_secret_list', 'clawops_secret_audit', 'clawops_plan'])

export const HOST_AGENT_READ_TOOLS: readonly string[] = TOOLSETS.read.filter((t) => !NOT_ON_HOST.has(t))

/** Destructive tools that may be allowed, each of which hands off rather than running (§4). */
export const HANDOFF_TOOLS: readonly string[] = [
  'clawops_gateway_restart',
  'clawops_gateway_update',
  'clawops_backup_restore',
  'clawops_config_set',
  'clawops_config_unset',
  'clawops_harden',
]

/**
 * Operations that end the host or stack the agent runs on. A host agent manages only its own
 * stack, so each of these would always target itself. They are refused with no command offered:
 * an agent proposing to remove itself is a sign of injection, not a maintenance request.
 */
export const SELF_TARGETING_TOOLS: readonly string[] = [
  'clawops_destroy',
  'clawops_stacks_delete',
  'clawops_migrate',
]

export const SELF_TARGETING_REFUSAL =
  'Refused. This would remove or move the host this agent runs on, and a host agent never ' +
  'proposes that. Destroying, deleting or migrating a stack is done by the operator, from ' +
  'their own machine, on their own initiative.'

/** Why a tool outside both sets cannot be allowed. */
export function notAllowableReason(tool: string): string {
  if (SELF_TARGETING_TOOLS.includes(tool)) {
    return `${tool} would remove or move the host the agent runs on, and is never allowed.`
  }
  if (HOST_AGENT_READ_TOOLS.includes(tool)) {
    return `${tool} is a read tool; every host agent has it already.`
  }
  return (
    `${tool} cannot be allowed: it needs the operator's machine (Pulumi state, cloud ` +
    `credentials or the clawops config). Allowable: ${HANDOFF_TOOLS.join(', ')}.`
  )
}

/** The tools a host agent serves: every read tool, plus the allowed handoff tools. */
export function hostAgentToolNames(allow: readonly string[]): string[] {
  return [...HOST_AGENT_READ_TOOLS, ...HANDOFF_TOOLS.filter((t) => allow.includes(t))]
}
