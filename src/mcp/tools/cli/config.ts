// clawops_config_get + clawops_config_set + clawops_config_unset + clawops_config_validate handlers

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ConfigGetInput, ConfigSetInput, ConfigUnsetInput, ConfigValidateInput } from '../_generated.js'
import { buildContext } from '../../../cli/context.js'
import { acquireSession, drainPool } from '../../../transport/pool.js'
import { resolveConn, okText, errText } from '../_conn.js'
import { OPENCLAW_CONFIG, atomicWriteConfig, restartGateway as restartGatewayShared } from '../../../plan/remote-config.js'

const VALID_AUTH_MODES = new Set(['none', 'token', 'password', 'trusted-proxy'])

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
    const issues = validateOpenclawConfig(cfg)
    return okText(JSON.stringify({ valid: issues.length === 0, issues }))
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

export function validateOpenclawConfig(cfg: Record<string, unknown>): string[] {
  const issues: string[] = []

  if ('version' in cfg) {
    issues.push(
      "Top-level 'version' is not a valid OpenClaw config key. " +
      "Use 'meta.lastTouchedVersion' (string) instead.",
    )
  }

  if ('channels' in cfg && Array.isArray(cfg['channels'])) {
    issues.push(
      "'channels' must be an object keyed by provider name (e.g. {\"discord\":{...}}), not an array.",
    )
  }

  const meta = cfg['meta']
  if (meta !== undefined && (typeof meta !== 'object' || Array.isArray(meta) || meta === null)) {
    issues.push("'meta' must be an object.")
  } else if (meta && typeof meta === 'object') {
    const ltv = (meta as Record<string, unknown>)['lastTouchedVersion']
    if (ltv !== undefined && typeof ltv !== 'string') {
      issues.push("'meta.lastTouchedVersion' must be a string.")
    }
  }

  const gateway = cfg['gateway']
  if (gateway !== undefined && typeof gateway === 'object' && !Array.isArray(gateway) && gateway !== null) {
    const gw = gateway as Record<string, unknown>
    if ('port' in gw && typeof gw['port'] !== 'number') {
      issues.push("'gateway.port' must be a number.")
    }
    const auth = gw['auth']
    if (auth !== undefined && typeof auth === 'object' && !Array.isArray(auth) && auth !== null) {
      const mode = (auth as Record<string, unknown>)['mode']
      if (mode !== undefined && !VALID_AUTH_MODES.has(mode as string)) {
        issues.push(
          `'gateway.auth.mode' must be one of: ${[...VALID_AUTH_MODES].join(', ')}. Got: "${mode}".`,
        )
      }
    }
  }

  return issues
}
