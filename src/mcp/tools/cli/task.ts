// clawops_task_status handler

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { TaskStatusInput } from '../_generated.js'
import { getTask } from '../../progress.js'

export async function handleTaskStatus(input: TaskStatusInput, _server: McpServer): Promise<CallToolResult> {
  const record = getTask(input.taskId)
  if (!record) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ taskId: input.taskId, status: 'not_found' }) }],
      isError: true,
    }
  }
  return { content: [{ type: 'text', text: JSON.stringify(record, null, 2) }] }
}
