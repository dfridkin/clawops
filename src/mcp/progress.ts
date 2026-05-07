// MCP progress notification helpers — per R12.
// sync <10s, notifications 10–60s, taskId >60s.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

export type TaskStatus = 'running' | 'completed' | 'failed' | 'cancelled'

export interface TaskRecord {
  id: string
  description: string
  status: TaskStatus
  startedAt: string
  updatedAt: string
  result?: string
  error?: string
}

// In-memory task map — sufficient for M5 (single-process, no persistence needed)
const taskMap = new Map<string, TaskRecord>()

export function startTask(id: string, description: string): TaskRecord {
  const now = new Date().toISOString()
  const record: TaskRecord = { id, description, status: 'running', startedAt: now, updatedAt: now }
  taskMap.set(id, record)
  return record
}

export function updateTask(id: string, status: TaskStatus, result?: string, error?: string): void {
  const record = taskMap.get(id)
  if (!record) return
  record.status = status
  record.updatedAt = new Date().toISOString()
  if (result !== undefined) record.result = result
  if (error !== undefined) record.error = error
}

export function getTask(id: string): TaskRecord | undefined {
  return taskMap.get(id)
}

/**
 * Returns an `emit(message)` function that sends a progress notification
 * if a progressToken is present. Safe to call even without a token.
 */
export function makeProgressEmitter(
  server: McpServer,
  progressToken: string | number | undefined,
): (message: string) => void {
  if (!progressToken) return () => {}
  return (message: string) => {
    server.server
      .notification({
        method: 'notifications/progress',
        params: { progressToken, progress: 0, message },
      })
      .catch(() => {}) // never crash the tool on notification failure
  }
}
