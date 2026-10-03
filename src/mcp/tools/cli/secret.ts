// clawops_secret_list, clawops_secret_audit, clawops_secret_delete handlers.
//
// The operations, warnings and refusals come from src/secrets/store.ts, the same module
// `clawops secret` calls, so the two surfaces cannot drift in what they say or refuse. None of
// these returns a secret's value; `secret set` and `secret rotate` have no tool at all, because
// a value passed as a tool argument would land in the transcript (R6).

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { SecretListInput, SecretAuditInput, SecretDeleteInput } from '../_generated.js'
import { errText, okText } from '../_conn.js'
import { trimForMcp } from '../_trim.js'
import { confirmDestructive } from '../_confirm.js'
import {
  listSecrets,
  auditSecrets,
  prepareSecretDelete,
  deletePreparedSecret,
  deleteConfirmQuestion,
  NO_SECRETS_MESSAGE,
  SET_SECRET_HINT,
  AUDIT_CLEAN_MESSAGE,
  AUDIT_FIX_HINT,
} from '../../../secrets/store.js'

/** The name trimmed output is persisted under for the last-run resource (R14). */
const RESOURCE_NAME = 'secrets'

function capped(payload: unknown): CallToolResult {
  const { content } = trimForMcp(JSON.stringify(payload, null, 2), RESOURCE_NAME)
  return okText(content)
}

export async function handleSecretList(_input: SecretListInput, _server: McpServer): Promise<CallToolResult> {
  const secrets = listSecrets()
  if (secrets.length === 0) {
    return capped({ secrets, message: `${NO_SECRETS_MESSAGE} ${SET_SECRET_HINT}` })
  }
  return capped({ secrets })
}

export async function handleSecretAudit(_input: SecretAuditInput, _server: McpServer): Promise<CallToolResult> {
  const report = auditSecrets()
  return capped({
    ...report,
    message: report.ok ? AUDIT_CLEAN_MESSAGE : AUDIT_FIX_HINT,
  })
}

export async function handleSecretDelete(input: SecretDeleteInput, server: McpServer): Promise<CallToolResult> {
  const prepared = prepareSecretDelete(input.name)
  if (!prepared.ok) return errText(prepared.reason)

  // R19: confirm unless the caller says the user already approved. The warning goes into the
  // question, so the human approving sees which stacks this will break before saying yes.
  if (!input.yes) {
    const confirmation = await confirmDestructive(server, {
      message: [deleteConfirmQuestion(prepared.name), ...prepared.warnings].join('\n'),
      title: `Delete secret "${prepared.name}"`,
      what: `deleting secret "${prepared.name}"`,
    })
    if (!confirmation.confirmed) {
      return okText([confirmation.reason, ...prepared.warnings].join('\n'))
    }
  }

  const message = deletePreparedSecret(prepared)
  return capped({
    deleted: prepared.name,
    message,
    referencingStacks: prepared.referencingStacks,
    warnings: prepared.warnings,
  })
}
