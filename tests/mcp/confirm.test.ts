// Confirming a destructive action, including when the client cannot be asked.
//
// R19 says nothing destructive runs unconfirmed. Elicitation is a client capability, and calling
// it on a client that never declared it throws from inside the SDK: "Client does not support form
// elicitation" — which names no tool, no stack, and nothing the caller can do. Glama's inspector
// got exactly that from clawops_up.

import { describe, it, expect, vi } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { confirmDestructive } from '../../src/mcp/tools/_confirm.js'

const OPTS = { message: 'Destroy "prod"?', title: 'Confirm', what: 'destroying a stack' }

function server(capabilities: unknown, elicit?: unknown): McpServer {
  return {
    server: {
      getClientCapabilities: () => capabilities,
      elicitInput: vi.fn().mockResolvedValue(elicit),
    },
  } as unknown as McpServer
}

describe('confirmDestructive', () => {
  it('confirms when the user accepts', async () => {
    const s = server({ elicitation: {} }, { action: 'accept', content: { confirmed: true } })
    expect(await confirmDestructive(s, OPTS)).toEqual({ confirmed: true })
  })

  it.each([
    ['declined outright', { action: 'decline' }],
    ['dismissed', { action: 'cancel' }],
    ['accepted with the box unticked', { action: 'accept', content: { confirmed: false } }],
  ])('does not confirm when %s', async (_label, elicit) => {
    const s = server({ elicitation: {} }, elicit)
    const result = await confirmDestructive(s, OPTS)
    expect(result.confirmed).toBe(false)
    if (!result.confirmed) expect(result.reason).toMatch(/Nothing was changed/)
  })

  describe('a client that cannot be asked', () => {
    it('refuses, and says how to confirm instead', async () => {
      const s = server({})
      const result = await confirmDestructive(s, OPTS)
      expect(result.confirmed).toBe(false)
      if (!result.confirmed) {
        expect(result.reason).toMatch(/yes: true/)
        expect(result.reason).toMatch(/destroying a stack/)
      }
    })

    it('never asks it anyway', async () => {
      const s = server({})
      await confirmDestructive(s, OPTS)
      expect(s.server.elicitInput).not.toHaveBeenCalled()
    })

    // The failure this replaces: an SDK throw the caller could neither read nor act on.
    it('does not throw', async () => {
      await expect(confirmDestructive(server(undefined), OPTS)).resolves.toBeDefined()
      await expect(confirmDestructive(server(null), OPTS)).resolves.toBeDefined()
    })
  })
})
