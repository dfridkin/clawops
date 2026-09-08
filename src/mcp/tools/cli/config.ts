// clawops_config_get + clawops_config_set + clawops_config_unset + clawops_config_validate handlers

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ConfigGetInput, ConfigSetInput, ConfigUnsetInput, ConfigValidateInput } from '../_generated.js'
import { buildContext } from '../../../cli/context.js'
import { acquireSession, drainPool } from '../../../transport/pool.js'
import { resolveConn, okText, errText } from '../_conn.js'
import { OPENCLAW_CONFIG, atomicWriteConfig, restartGateway as restartGatewayShared } from '../../../plan/remote-config.js'


export async function handleConfigGet(input: ConfigGetInput, _server: McpServer): Promise<CallToolResult> {
  const ac = new AbortController()
  const ctx = buildContext({ stack: input.stackName })
  const conn = await resolveConn(ctx)
  const { session, release } = await acquireSession(conn)
  try {
    const result = await session.exec(`cat ${OPENCLAW_CONFIG}`, ac.signal)
    let cfg: Record<string, unknown>
    try {
      cfg = JSON.parse(result.stdout) as Record<string, unknown>
    } catch {
      return errText(`Cannot parse ${OPENCLAW_CONFIG}: ${result.stderr || result.stdout}`)
    }
    const value = input.key ? getPath(cfg, input.key) : cfg
    return okText(JSON.stringify(value, null, 2))
  } finally {
    release()
    drainPool()
  }
}

export async function handleConfigSet(input: ConfigSetInput, server: McpServer): Promise<CallToolResult> {
  const elicit = await server.server.elicitInput({
    message: `Set ${input.key} = ${input.value} on stack "${input.stackName ?? 'default'}"?`,
    requestedSchema: {
      type: 'object' as const,
      properties: { confirmed: { type: 'boolean' as const, title: 'Confirm config change' } },
      required: ['confirmed'],
    },
  })
  if (elicit.action !== 'accept' || !elicit.content?.['confirmed']) {
    return okText('Config change cancelled.')
  }

  const ac = new AbortController()
  const ctx = buildContext({ stack: input.stackName })
  const conn = await resolveConn(ctx)
  const { session, release } = await acquireSession(conn)
  try {
    const readResult = await session.exec(`cat ${OPENCLAW_CONFIG}`, ac.signal)
    let cfg: Record<string, unknown>
    try {
      cfg = JSON.parse(readResult.stdout) as Record<string, unknown>
    } catch {
      return errText(`Cannot parse ${OPENCLAW_CONFIG}: ${readResult.stderr}`)
    }

    let parsedValue: unknown = input.value
    try { parsedValue = JSON.parse(input.value) } catch { /* keep string */ }
    setPath(cfg, input.key, parsedValue)

    try {
      await atomicWriteConfig(session, cfg, ac.signal)
    } catch (err) {
      return errText(`Failed to write config: ${(err as Error).message}`)
    }

    let note = ''
    if (input.restart) {
      try {
        await restartGatewayShared(session, ac.signal)
        note = ' (gateway restarted)'
      } catch (err) {
        return errText(`Gateway restart failed: ${(err as Error).message}`)
      }
    }
    return okText(`Config set: ${input.key}${note}`)
  } finally {
    release()
    drainPool()
  }
}

export async function handleConfigUnset(input: ConfigUnsetInput, server: McpServer): Promise<CallToolResult> {
  const elicit = await server.server.elicitInput({
    message: `Remove config key "${input.key}" on stack "${input.stackName ?? 'default'}"?`,
    requestedSchema: {
      type: 'object' as const,
      properties: { confirmed: { type: 'boolean' as const, title: 'Confirm key removal' } },
      required: ['confirmed'],
    },
  })
  if (elicit.action !== 'accept' || !elicit.content?.['confirmed']) {
    return okText('Config unset cancelled.')
  }

  const ac = new AbortController()
  const ctx = buildContext({ stack: input.stackName })
  const conn = await resolveConn(ctx)
  const { session, release } = await acquireSession(conn)
  try {
    const readResult = await session.exec(`cat ${OPENCLAW_CONFIG}`, ac.signal)
    let cfg: Record<string, unknown>
    try {
      cfg = JSON.parse(readResult.stdout) as Record<string, unknown>
    } catch {
      return errText(`Cannot parse ${OPENCLAW_CONFIG}: ${readResult.stderr}`)
    }

    deletePath(cfg, input.key)

    try {
      await atomicWriteConfig(session, cfg, ac.signal)
    } catch (err) {
      return errText(`Failed to write config: ${(err as Error).message}`)
    }

    let note = ''
    if (input.restart) {
      try {
        await restartGatewayShared(session, ac.signal)
        note = ' (gateway restarted)'
      } catch (err) {
        return errText(`Gateway restart failed: ${(err as Error).message}`)
      }
    }
    return okText(`Config key removed: ${input.key}${note}`)
  } finally {
    release()
    drainPool()
  }
}

export async function handleConfigValidate(input: ConfigValidateInput, _server: McpServer): Promise<CallToolResult> {
  const ac = new AbortController()
  const ctx = buildContext({ stack: input.stackName })
  const conn = await resolveConn(ctx)
  const { session, release } = await acquireSession(conn)
  try {
    const result = await session.exec(`cat ${OPENCLAW_CONFIG}`, ac.signal)
    let cfg: Record<string, unknown>
    try {
      cfg = JSON.parse(result.stdout) as Record<string, unknown>
    } catch {
      return okText(JSON.stringify({ valid: false, issues: [`Invalid JSON: ${result.stderr || result.stdout}`] }))
    }
    const { validateConfig } = await import('../../../openclaw/config-validate.js')
    const yaml = await import('js-yaml')
    const { loadVersionSpec } = await import('../../../openclaw/versions.js')
    const spec = loadVersionSpec(yaml)
    const { errors, warnings } = await validateConfig(cfg, {
      schemaCapturedFrom: spec.runtime?.configSchemaCapturedFrom,
    })
    return okText(JSON.stringify({ valid: errors.length === 0, issues: errors, warnings }))
  } finally {
    release()
    drainPool()
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getPath(obj: Record<string, unknown>, dotKey: string): unknown {
  return dotKey.split('.').reduce<unknown>((cur, k) => {
    if (cur !== null && typeof cur === 'object') return (cur as Record<string, unknown>)[k]
    return undefined
  }, obj)
}

function setPath(obj: Record<string, unknown>, dotKey: string, value: unknown): void {
  const keys = dotKey.split('.')
  let cur: Record<string, unknown> = obj
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]!
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {}
    cur = cur[k] as Record<string, unknown>
  }
  cur[keys[keys.length - 1]!] = value
}

function deletePath(obj: Record<string, unknown>, dotKey: string): void {
  const keys = dotKey.split('.')
  let cur: Record<string, unknown> = obj
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]!
    if (typeof cur[k] !== 'object' || cur[k] === null) return
    cur = cur[k] as Record<string, unknown>
  }
  delete cur[keys[keys.length - 1]!]
}

// The hand-written validator that used to live here checked five things: a top-level
// `version` key, `channels` as an array, `meta` shape, `gateway.port` type and
// `gateway.auth.mode`. It knew nothing of `gateway.mode` — the field whose absence exits
// the gateway 78 — and nothing of models.providers. Replaced by validation against the
// schema OpenClaw publishes: src/openclaw/config-validate.ts.
