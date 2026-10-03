// clawops_gateway_restart, clawops_gateway_status and clawops_gateway_update handlers.
//
// Status and update run the same code as `clawops gateway status|update`
// (src/openclaw/gateway-ops.ts), so the two surfaces cannot drift in what they do or refuse.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { randomUUID } from 'node:crypto'
import type { GatewayRestartInput, GatewayStatusInput, GatewayUpdateInput } from '../_generated.js'
import { buildContext } from '../../../cli/context.js'
import { acquireSession, drainPool } from '../../../transport/pool.js'
import { resolveConn, okText, errText } from '../_conn.js'
import { restartGateway } from '../../../plan/remote-config.js'
import { confirmDestructive } from '../_confirm.js'
import { trimForMcp } from '../_trim.js'
import { makeProgressEmitter, startTask, updateTask } from '../../progress.js'
import {
  gatewayStatus, resolveUpdateVersion, currentGatewayVersion, updateGateway,
} from '../../../openclaw/gateway-ops.js'

export async function handleGatewayRestart(input: GatewayRestartInput, server: McpServer): Promise<CallToolResult> {
  // R19: always elicit
  const confirmation = await confirmDestructive(server, {
    message: `Restart the OpenClaw gateway on stack "${input.stackName ?? 'default'}"? This will briefly interrupt connections.`,
    title: 'Confirm restart',
    what: 'restarting the gateway',
  })
  if (!confirmation.confirmed) {
    return okText(confirmation.reason)
  }

  const ctx = buildContext({ stack: input.stackName })
  const conn = await resolveConn(ctx)
  const { session, release } = await acquireSession(conn)
  try {
    // The shared restart: same version, same publish scope, then wait for the gateway to
    // answer. This handler used to hand-write its own run command, twice: first missing the
    // v1.7.5 version fix, then the publish scope — so restarting a gateway deployed with
    // --publish-gateway all quietly took it off the public interface.
    await restartGateway(session)
    return okText('Gateway restarted.')
  } catch (e) {
    return errText((e as Error).message)
  } finally {
    release()
    drainPool()
  }
}

// ── clawops_gateway_status ──────────────────────────────────────────────────

export async function handleGatewayStatus(input: GatewayStatusInput, _server: McpServer): Promise<CallToolResult> {
  const ctx = buildContext({ stack: input.stackName })
  const conn = await resolveConn(ctx)
  const { session, release } = await acquireSession(conn)
  try {
    // The same reading as `clawops gateway status`: a missing container is an answer ("not
    // running"); docker being unreachable is an error, never a status — reporting "not
    // running" there would be a statement about the gateway when clawops could not ask.
    const status = await gatewayStatus(session)
    if (!status.ok) return errText(status.error)
    return okText(trimForMcp(JSON.stringify(status.value, null, 2), ctx.stackName).content)
  } finally {
    release()
    drainPool()
  }
}

// ── clawops_gateway_update ──────────────────────────────────────────────────

export async function handleGatewayUpdate(input: GatewayUpdateInput, server: McpServer): Promise<CallToolResult> {
  // The version is checked before anything else, and refused in the CLI's words: a moving tag
  // or an out-of-range release never reaches the host, and is not worth a confirmation.
  // The CLI reads a missing version as "the recommended pin". The tool's version is required
  // because an update an agent did not name is not one it should run, so an empty string is
  // refused rather than quietly upgraded to whatever this release recommends.
  if (input.version.trim() === '') {
    return errText('version is required: name the concrete OpenClaw version to move to, e.g. 2026.9.2.')
  }
  const target = await resolveUpdateVersion(input.version)
  if (!target.ok) return errText(target.error)
  const version = target.value

  const ctx = buildContext({ stack: input.stackName })
  const conn = await resolveConn(ctx)
  const { session, release } = await acquireSession(conn)
  try {
    // R19. The current version is one read-only `docker inspect`, so the question can say
    // what is being replaced as well as what replaces it.
    if (!input.yes) {
      const current = await currentGatewayVersion(session).catch(() => undefined)
      const confirmation = await confirmDestructive(server, {
        message:
          `Update the OpenClaw gateway on stack "${ctx.stackName}" ` +
          `${current ? `from ${current} ` : ''}to ${version}? Every agent on the host restarts ` +
          'with it. A snapshot of the state database is taken first.',
        title: 'Confirm update',
        what: `updating the gateway to ${version}`,
      })
      if (!confirmation.confirmed) return okText(confirmation.reason)
    }

    // R12: a pull, a preflight and a startup gate that polls for up to 30s (twice more if it
    // repairs or rolls back) can run well past 10s. Same pattern as clawops_up/apply: the run
    // is recorded as a task and reports progress as it goes.
    const taskId = randomUUID()
    const emit = makeProgressEmitter(server, undefined)
    startTask(taskId, `clawops_gateway_update stack=${ctx.stackName} version=${version}`)
    const notes: string[] = []
    try {
      emit(`Updating gateway to ${version}...`)
      const result = await updateGateway(session, version, {
        onProgress: emit,
        onNote: (text) => { notes.push(text); emit(text) },
      })
      const text = [result.message, ...(result.ok ? [] : result.hint ? [result.hint] : []), ...notes]
        .join('\n')
      updateTask(taskId, result.ok ? 'completed' : 'failed', result.ok ? text : undefined, result.ok ? undefined : text)
      const { content } = trimForMcp(text, ctx.stackName)
      return result.ok ? okText(content) : errText(content)
    } catch (e) {
      updateTask(taskId, 'failed', undefined, e instanceof Error ? e.message : String(e))
      throw e
    }
  } finally {
    release()
    drainPool()
  }
}
