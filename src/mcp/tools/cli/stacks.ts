// clawops_stacks_list and clawops_stacks_delete handlers

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { StacksListInput, StacksDeleteInput } from '../_generated.js'
import { getConfig } from '../../../config/store.js'
import { checkStackDelete, deleteStackFromConfig, forgetNotice } from '../../../config/stack-delete.js'
import { confirmDestructive } from '../_confirm.js'
import { okText, errText } from '../_conn.js'

export async function handleStacksList(_input: StacksListInput, _server: McpServer): Promise<CallToolResult> {
  const config = getConfig()
  if (!config) {
    return { content: [{ type: 'text', text: JSON.stringify({ stacks: [] }) }] }
  }
  const stacks = Object.entries(config.stacks).map(([name, cfg]) => ({
    name,
    provider: cfg.provider,
    region: cfg.region,
    stateUrl: cfg.stateUrl,
    isDefault: name === config.defaults.stack,
  }))
  return { content: [{ type: 'text', text: JSON.stringify({ stacks }, null, 2) }] }
}

/**
 * clawops_stacks_delete — forget a stack. The checks and the config write are the CLI's
 * (src/config/stack-delete.ts), so the tool refuses exactly what `clawops stacks delete` does,
 * in the same words; `force` is `--force`.
 */
export async function handleStacksDelete(input: StacksDeleteInput, server: McpServer): Promise<CallToolResult> {
  const force = input.force === true
  const check = await checkStackDelete(input.name, { force })
  if (!check.ok) return errText(check.reason)

  // R19: confirm unless the caller says the user already approved.
  if (!input.yes) {
    const consequence = force
      ? 'force skips the still-deployed check: if this stack is still deployed, its resources ' +
        'stay running and billing, and clawops can no longer see them.'
      : check.warnings.length > 0
        ? `${check.warnings.join(' ')} If it is still deployed, its resources stay running and billing.`
        : 'clawops sees no deployment for it, so nothing should be left running.'
    const confirmation = await confirmDestructive(server, {
      message:
        `Forget stack "${input.name}"? This removes it from ~/.clawops/config.json; it does NOT ` +
        `tear down its infrastructure. ${consequence}` +
        (check.isDefault ? ' It is the default stack, so another stack becomes the default.' : ''),
      title: 'Confirm forgetting the stack',
      what: `forgetting stack "${input.name}"`,
    })
    if (!confirmation.confirmed) return okText(confirmation.reason)
  }

  const deleted = deleteStackFromConfig(input.name)
  const lines = [...check.warnings, forgetNotice(input.name), deleted.message]
  if (deleted.newDefaultMessage) lines.push(deleted.newDefaultMessage)
  return okText(lines.join('\n'))
}
