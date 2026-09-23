// clawops_destroy handler

import { randomUUID } from 'node:crypto'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { DestroyInput } from '../_generated.js'
import { buildContext } from '../../../cli/context.js'
import { makeProgressEmitter, startTask, updateTask } from '../../progress.js'
import { okText, errText } from '../_conn.js'
import { trimForMcp } from '../_trim.js'
import { confirmDestructive } from '../_confirm.js'

export async function handleDestroy(input: DestroyInput, server: McpServer): Promise<CallToolResult> {
  // R19: elicit unless yes flag
  if (!input.yes) {
    const confirmation = await confirmDestructive(server, {
      message: `DESTROY stack "${input.stackName}"? This permanently deletes all provisioned resources and cannot be undone.`,
      title: 'Confirm destruction (irreversible)',
      what: 'destroying a stack',
    })
    if (!confirmation.confirmed) {
      return okText(confirmation.reason)
    }
  }

  const ctx = buildContext({ stack: input.stackName })

  if (ctx.adapter.name === 'local') {
    return errText('Local provider stacks are destroyed with `clawops down --destroy` via SSH. Use clawops_up with the local provider instead.')
  }

  const taskId = randomUUID()
  const emit = makeProgressEmitter(server, undefined)
  startTask(taskId, `clawops_destroy stack=${input.stackName}`)

  try {
    const stack = await ctx.getStack()
    const lines: string[] = []
    await stack.destroy({ onOutput: (o) => { emit(o.trim()); lines.push(o) } })
    const fullOutput = lines.join('')
    updateTask(taskId, 'completed', `Stack "${input.stackName}" destroyed.`)
    const { content } = trimForMcp(fullOutput, input.stackName)
    return okText(`Stack "${input.stackName}" destroyed.\n\n${content}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    updateTask(taskId, 'failed', undefined, msg)
    throw err
  }
}
