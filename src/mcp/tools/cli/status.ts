// clawops_status handler

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { StatusInput } from '../_generated.js'
import { buildContext } from '../../../cli/context.js'
import { extractBaseOutputs } from '../../../pulumi/outputs.js'
import { StateError } from '../../../errors/index.js'
import { hostAgent } from '../../../hostagent/mode.js'
import { pendingHandoffs } from '../../../hostagent/handoff.js'
import { currentContainerReach } from '../../../hostagent/live.js'

export async function handleStatus(input: StatusInput, _server: McpServer): Promise<CallToolResult> {
  const ctx = buildContext({ stack: input.stackName })

  // A host agent reads no Pulumi state. It reports what it is, and what it has handed off;
  // the gateway's own health is clawops_gateway_status and clawops_monitor.
  const agent = hostAgent()
  if (agent) {
    // Reported here so the agent can tell its operator. Under --strict these refuse instead,
    // and this call would not have run.
    const reach = await currentContainerReach(agent)
    return text(JSON.stringify({
      stack: agent.stack,
      provider: agent.provider,
      hostAgent: { agentId: agent.agentId, operators: agent.operators, handsOff: agent.allow, strict: agent.strict },
      pendingHandoffs: pendingHandoffs().map((h) => ({ at: h.at, command: h.command })),
      ...(reach.length > 0 ? { otherAgentsInContainer: reach } : {}),
    }, null, 2))
  }

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
