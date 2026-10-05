// clawops_migrate handler — move a 1.x deployment onto the 2.0 runtime contract.
//
// Runs the same flow as `clawops migrate` (src/openclaw/migrate-flow.ts): the same target
// guard, the same steps, the same refusals in the same words.
//
// R12: a migration backs up, extracts, pulls the 2.x image and gates the gateway twice, which
// can run well past 60 seconds — but the refusals (already on 2.x, nothing to migrate, backup
// failed) come back in seconds. So the handler waits up to SYNC_WINDOW.ms for an outcome; if
// one arrives it is returned directly, and otherwise the caller gets a taskId to poll with
// clawops_task_status while the migration finishes in the background.

import { randomUUID } from 'node:crypto'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { MigrateInput } from '../_generated.js'
import { okText, errText } from '../_conn.js'
import { trimForMcp } from '../_trim.js'
import { confirmDestructive } from '../_confirm.js'
import { makeProgressEmitter, startTask, updateTask } from '../../progress.js'
import { UsageError } from '../../../errors/index.js'
import {
  prepareMigration, runMigration, migrationQuestion, type MigrationResult, type MigrationTarget,
} from '../../../openclaw/migrate-flow.js'

/**
 * How long to wait for an outcome before handing back a taskId instead — R12's sync bound.
 * An object so tests can shorten it without waiting ten real seconds.
 */
export const SYNC_WINDOW = { ms: 10_000 }

export async function handleMigrate(input: MigrateInput, server: McpServer): Promise<CallToolResult> {
  // Target guard and stack resolution first: there is no point confirming a migration the
  // version guard is about to refuse. The refusal is the CLI's, word for word.
  let target: MigrationTarget
  try {
    target = await prepareMigration({ stack: input.stackName, openclawVersion: input.openclawVersion })
  } catch (err) {
    if (err instanceof UsageError) return errText(err.message)
    throw err
  }

  // R19: confirm unless the caller says the user already approved.
  if (!input.yes) {
    const confirmation = await confirmDestructive(server, {
      message: migrationQuestion(target),
      title: `Confirm migrating "${target.stackName}" to ${target.version}`,
      what: `migrating stack "${target.stackName}"`,
    })
    if (!confirmation.confirmed) return okText(confirmation.reason)
  }

  const taskId = randomUUID()
  const emit = makeProgressEmitter(server, undefined)
  startTask(taskId, `clawops_migrate stack=${target.stackName} target=${target.version}`)

  // No AbortSignal, deliberately: the migration outlives this call, and must not be abandoned
  // between stopping 1.x and starting 2.0 because the caller stopped waiting.
  const run = runMigration(target, {
    onStep: (text) => {
      emit(text)
      updateTask(taskId, 'running', text)
    },
  }).then(
    (result) => {
      const text = render(result, target.stackName)
      updateTask(taskId, result.exitCode === 0 ? 'completed' : 'failed', text, result.exitCode === 0 ? undefined : text)
      return { kind: 'done' as const, result, text }
    },
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      updateTask(taskId, 'failed', undefined, msg)
      return { kind: 'error' as const, err, msg }
    },
  )

  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<{ kind: 'pending' }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'pending' }), SYNC_WINDOW.ms)
  })
  const first = await Promise.race([run, timeout])
  clearTimeout(timer)

  if (first.kind === 'pending') {
    return okText(
      JSON.stringify(
        {
          taskId,
          status: 'running',
          stack: target.stackName,
          target: target.version,
          message:
            'The migration is still running on the host. Poll clawops_task_status with this taskId ' +
            'for the outcome; do not start another migration of this stack meanwhile.',
        },
        null,
        2,
      ),
    )
  }
  if (first.kind === 'error') {
    if (first.err instanceof UsageError) return errText(first.msg)
    throw first.err
  }
  return first.result.exitCode === 0 ? okText(first.text) : errText(first.text)
}

function render(result: MigrationResult, stackName: string): string {
  const text = result.lines.map((l) => l.text).join('\n')
  return trimForMcp(text, stackName).content
}
