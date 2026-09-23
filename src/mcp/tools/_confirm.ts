// Asking before doing something destructive, including when the client cannot be asked.
//
// R19 says a destructive tool confirms before it runs unless `yes: true` was passed. The
// confirmation is an elicitation, and elicitation is a client capability: a client declares it
// at initialize, and many do not have it. Calling it anyway throws from inside the SDK, and the
// caller gets "Client does not support form elicitation" — which names no tool, no stack, and
// nothing to do about it. Glama's inspector hit exactly that on clawops_up.
//
// The rule that matters is unchanged: without a confirmation, nothing destructive runs. What
// changes is that being unable to ask is now an answer the caller can act on — pass `yes: true`
// — rather than an error from a layer they cannot see.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

export type Confirmation =
  | { confirmed: true }
  | { confirmed: false; reason: string }

/**
 * Ask the caller's client to confirm, and say plainly what happened if it cannot.
 *
 * `title` is what the confirmation checkbox says; `message` is the question. Both reach a human
 * in a client that supports elicitation, so they name the stack and the consequence.
 */
export async function confirmDestructive(
  server: McpServer,
  opts: { message: string; title: string; what: string },
): Promise<Confirmation> {
  const capabilities = server.server.getClientCapabilities()
  if (!capabilities?.elicitation) {
    return {
      confirmed: false,
      reason:
        `This client cannot show a confirmation prompt, and ${opts.what} is not something ` +
        'clawops will do unconfirmed. Ask the user to confirm, then call this tool again with ' +
        '`yes: true`. (The client did not declare the MCP elicitation capability.)',
    }
  }

  const elicit = await server.server.elicitInput({
    message: opts.message,
    requestedSchema: {
      type: 'object' as const,
      properties: { confirmed: { type: 'boolean' as const, title: opts.title } },
      required: ['confirmed'],
    },
  })

  if (elicit.action !== 'accept' || !elicit.content?.['confirmed']) {
    return { confirmed: false, reason: `Cancelled — ${opts.what} did not run. Nothing was changed.` }
  }
  return { confirmed: true }
}
