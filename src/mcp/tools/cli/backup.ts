// clawops_backup_create and clawops_backup_restore handlers.
//
// The sequence is src/openclaw/backup-flows.ts, which `clawops backup` runs too; these handlers
// add only what the MCP surface needs: absolute paths (R7), a confirmation before a restore
// (R19), task records and progress for operations that run well past ten seconds (R12), and a
// result capped at 8KB (R14). Refusals are the flow's own words, so an agent is told exactly
// what an operator at the terminal would be.

import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { BackupCreateInput, BackupRestoreInput } from '../_generated.js'
import { buildContext } from '../../../cli/context.js'
import { acquireSession, drainPool } from '../../../transport/pool.js'
import { getConfigDir } from '../../../config/store.js'
import {
  ACTIVATED, ARCHIVE_IS_A_CREDENTIAL, PLUGINS_NOT_CARRIED,
  activateStaged, activatedLines, activationFailureDetail, createBackup,
  defaultBackupFilename, nothingChanged, stageRestore,
} from '../../../openclaw/backup-flows.js'
import { makeProgressEmitter, startTask, updateTask } from '../../progress.js'
import { resolveConn, okText, errText } from '../_conn.js'
import { trimForMcp } from '../_trim.js'
import { confirmDestructive } from '../_confirm.js'

/** R7: the server ignores its launch directory, so a relative path has nothing to resolve against. */
function relativePathRefusal(param: 'out' | 'file', value: string): string {
  return (
    `"${param}" must be an absolute path; got "${value}". The MCP server does not resolve ` +
    'paths against a working directory. Pass the full path, e.g. /Users/me/backups/openclaw.tar.gz.'
  )
}

function capped(text: string, stackName: string, isError = false): CallToolResult {
  const { content } = trimForMcp(text, stackName)
  return isError ? errText(content) : okText(content)
}

export async function handleBackupCreate(input: BackupCreateInput, server: McpServer): Promise<CallToolResult> {
  if (input.out !== undefined && !path.isAbsolute(input.out)) {
    return errText(relativePathRefusal('out', input.out))
  }

  const ctx = buildContext({ stack: input.stackName })
  let outPath = input.out
  if (outPath === undefined) {
    const dir = path.join(getConfigDir(), 'backups')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    outPath = path.join(dir, defaultBackupFilename())
  }

  // R12: a backup streams the whole state database and can run for minutes. The task record is
  // what clawops_task_status reports; progress goes out as notifications where a token exists.
  const taskId = randomUUID()
  const emit = makeProgressEmitter(server, undefined)
  startTask(taskId, `clawops_backup_create stack=${ctx.stackName}`)

  const ac = new AbortController()
  const conn = await resolveConn(ctx)
  const { session, release } = await acquireSession({ ...conn, signal: ac.signal })
  try {
    const created = await createBackup(session, {
      outPath,
      signal: ac.signal,
      onPhase: (phase) => emit(phase === 'creating' ? 'Creating backup on remote host...' : `Downloading to ${outPath}...`),
    })
    if (!created.ok) {
      updateTask(taskId, 'failed', undefined, created.reason)
      return capped(created.reason, ctx.stackName, true)
    }
    const summary = [`Backup saved to ${created.path}`, ...ARCHIVE_IS_A_CREDENTIAL].join('\n')
    updateTask(taskId, 'completed', summary)
    return capped(summary, ctx.stackName)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    updateTask(taskId, 'failed', undefined, msg)
    return errText(`Backup failed: ${msg}`)
  } finally {
    release()
    drainPool()
  }
}

export async function handleBackupRestore(input: BackupRestoreInput, server: McpServer): Promise<CallToolResult> {
  if (!path.isAbsolute(input.file)) {
    return errText(relativePathRefusal('file', input.file))
  }
  const activate = input.activate === true
  const stackLabel = input.stackName ?? 'default'

  // R19. The CLI asks only before activation, once it has shown what the archive held; an agent
  // has no such moment, so it confirms once, up front, and says which of the two it is.
  if (!input.yes) {
    const confirmation = await confirmDestructive(server, activate
      ? {
          message:
            `ACTIVATE the backup ${input.file} on stack "${stackLabel}"? The gateway is stopped and the ` +
            'restored state put into service. Everything since the backup is lost from the live gateway ' +
            '(the state it replaces is kept alongside it), and channel credentials may need relinking. ' +
            'clawops puts the previous state back if the gateway does not come up.',
          title: 'Confirm restore and activation',
          what: 'activating a restored backup',
        }
      : {
          message:
            `Expand the backup ${input.file} onto stack "${stackLabel}", staging only? It is verified and ` +
            'expanded beside the live state; the gateway and its live state are not touched.',
          title: 'Confirm staging-only restore',
          what: 'restoring a backup to a staging directory',
        })
    if (!confirmation.confirmed) return okText(confirmation.reason)
  }

  const ctx = buildContext({ stack: input.stackName })
  const taskId = randomUUID()
  const emit = makeProgressEmitter(server, undefined)
  startTask(taskId, `clawops_backup_restore stack=${ctx.stackName}${activate ? ' activate' : ''}`)
  const fail = (text: string): CallToolResult => {
    updateTask(taskId, 'failed', undefined, text)
    return capped(text, ctx.stackName, true)
  }

  const ac = new AbortController()
  const conn = await resolveConn(ctx)
  const { session, release } = await acquireSession({ ...conn, signal: ac.signal })
  try {
    const staged = await stageRestore(session, {
      file: input.file,
      signal: ac.signal,
      onPhase: (phase) => emit(phase === 'uploading' ? 'Uploading archive...' : 'Verifying and restoring to a staging directory...'),
    })
    const raw = staged.unparsedReport !== undefined ? [`OpenClaw reported: ${staged.unparsedReport}`] : []

    if (!staged.ok) {
      return fail([
        staged.reason,
        ...(staged.stagingOnHost ? [nothingChanged(staged.stagingOnHost)] : []),
        ...raw,
      ].join('\n'))
    }

    const lines = [
      `Archive verified and expanded to ${staged.stagingOnHost} on the host.`,
      ...(staged.entryCount !== undefined ? [`${staged.entryCount} entries restored.`] : []),
      ...raw,
      // Verbatim: rolled-back approvals and channel credentials are the operator's to judge.
      ...staged.warnings.map((w) => `Warning: ${w}`),
    ]

    if (!activate) {
      lines.push(
        '',
        'Nothing has been activated. Call clawops_backup_restore again with activate: true to put',
        'this state into service. The state to adopt is',
        `  ${staged.statePath}`,
        `(the archive holds ${staged.stateDirInArchive} under payload/posix), replacing ${staged.stateDir}.`,
        ...PLUGINS_NOT_CARRIED,
      )
      const text = lines.join('\n')
      updateTask(taskId, 'completed', text)
      return capped(text, ctx.stackName)
    }

    const outcome = await activateStaged(session, staged, {
      signal: ac.signal,
      onPhase: (phase) => {
        if (phase === 'activating') emit('Activating the restored state...')
        else if (phase === 'restarting') emit('Restarting the gateway...')
        else if (phase === 'waiting') emit('Waiting for the gateway to answer...')
      },
    })
    if (!outcome.ok) {
      return fail([...lines, '', outcome.reason, ...activationFailureDetail(outcome)].join('\n'))
    }

    lines.push('', ACTIVATED, ...activatedLines(outcome.preserved))
    const text = lines.join('\n')
    updateTask(taskId, 'completed', text)
    return capped(text, ctx.stackName)
  } catch (err) {
    return fail(`Restore failed: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    release()
    drainPool()
  }
}
