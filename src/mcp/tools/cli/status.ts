// clawops_status handler

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/dist/esm/types.js'
import type { StatusInput } from '../_generated.js'
import { buildContext } from '../../../cli/context.js'
import { extractBaseOutputs } from '../../../pulumi/outputs.js'
import { StateError } from '../../../errors/index.js'

export async function handleStatus(input: StatusInput, _server: McpServer): Promise<CallToolResult> {
  const ctx = buildContext({ stack: input.stackName })

  if (ctx.adapter.name === 'local') {
    const state = ctx.localState
    if (!state) {
      return text(JSON.stringify({ stack: ctx.stackName, status: 'not bootstrapped' }, null, 2))
    }
    return text(JSON.stringify({ stack: ctx.stackName, ...state }, null, 2))
  }

  const stack = await ctx.getStack()
  const outputMap = await stack.outputs()
  const outputs: Record<string, unknown> = Object.fromEntries(
    Object.entries(outputMap).map(([k, v]) => [k, v.value]),
  )

  if (!outputs['publicIp']) {
    return text(JSON.stringify({ stack: ctx.stackName, status: 'not deployed' }, null, 2))
  }

  try {
    const base = extractBaseOutputs(outputs)
    return text(JSON.stringify({ stack: ctx.stackName, ...base }, null, 2))
  } catch (err) {
    if (err instanceof StateError) {
      return text(JSON.stringify({ stack: ctx.stackName, status: 'not deployed', detail: err.message }, null, 2))
    }
    throw err
  }
}

function text(t: string): CallToolResult {
  return { content: [{ type: 'text', text: t }] }
}
