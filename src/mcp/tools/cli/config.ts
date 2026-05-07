// clawops_config_get + clawops_config_set handlers

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/dist/esm/types.js'
import type { ConfigGetInput, ConfigSetInput } from '../_generated.js'
import { buildContext } from '../../../cli/context.js'
import { acquireSession, drainPool } from '../../../transport/pool.js'
import { resolveConn, okText, errText } from '../_conn.js'

const OPENCLAW_CONFIG = '/home/clawops/openclaw.json'
const OPENCLAW_TMP = '/tmp/clawops-config.json.tmp'

export async function handleConfigGet(input: ConfigGetInput, _server: McpServer): Promise<CallToolResult> {
  const ctx = buildContext({ stack: input.stackName })
  const conn = await resolveConn(ctx)
  const { session, release } = await acquireSession(conn)
  try {
    const result = await session.exec(`cat ${OPENCLAW_CONFIG}`)
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
  // R19: always elicit for config changes
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

  const ctx = buildContext({ stack: input.stackName })
  const conn = await resolveConn(ctx)
  const { session, release } = await acquireSession(conn)
  try {
    const readResult = await session.exec(`cat ${OPENCLAW_CONFIG}`)
    let cfg: Record<string, unknown>
    try {
      cfg = JSON.parse(readResult.stdout) as Record<string, unknown>
    } catch {
      return errText(`Cannot parse ${OPENCLAW_CONFIG}: ${readResult.stderr}`)
    }

    let parsedValue: unknown = input.value
    try { parsedValue = JSON.parse(input.value) } catch { /* keep string */ }
    setPath(cfg, input.key, parsedValue)

    const json = JSON.stringify(cfg, null, 2)
    const b64 = Buffer.from(json, 'utf-8').toString('base64')
    const writeCmd =
      `echo '${b64}' | base64 -d > ${OPENCLAW_TMP} && ` +
      `mv ${OPENCLAW_TMP} ${OPENCLAW_CONFIG} && ` +
      `chown clawops:clawops ${OPENCLAW_CONFIG}`
    const writeResult = await session.exec(writeCmd)
    if (writeResult.code !== 0) {
      return errText(`Failed to write config: ${writeResult.stderr}`)
    }

    let note = ''
    if (input.restart) {
      const imgResult = await session.exec(
        `docker inspect openclaw --format '{{.Config.Image}}' 2>/dev/null || echo 'ghcr.io/openclaw/openclaw:stable'`,
      )
      const image = imgResult.stdout.trim()
      const restartCmd = [
        'docker stop openclaw 2>/dev/null || true',
        'docker rm openclaw 2>/dev/null || true',
        `docker run -d --name openclaw --restart unless-stopped -p 18789:18789 ` +
          `-v ${OPENCLAW_CONFIG}:/app/config.json:ro ${image}`,
      ].join(' && ')
      await session.exec(restartCmd)
      note = ' (gateway restarted)'
    }
    return okText(`Config set: ${input.key}${note}`)
  } finally {
    release()
    drainPool()
  }
}

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
