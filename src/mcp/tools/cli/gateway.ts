// clawops_gateway_restart handler

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { GatewayRestartInput } from '../_generated.js'
import { buildContext } from '../../../cli/context.js'
import { acquireSession, drainPool } from '../../../transport/pool.js'
import { resolveConn, okText, errText } from '../_conn.js'
import { IMAGE_INSPECT_CMD, imageForRestart } from '../../../openclaw/run-flags.js'
import { gatewayRunCommand } from '../../../openclaw/runtime.js'
import { OPENCLAW_CONFIG } from '../../../plan/remote-config.js'

export async function handleGatewayRestart(input: GatewayRestartInput, server: McpServer): Promise<CallToolResult> {
  // R19: always elicit
  const elicit = await server.server.elicitInput({
    message: `Restart the OpenClaw gateway on stack "${input.stackName ?? 'default'}"? This will briefly interrupt connections.`,
    requestedSchema: {
      type: 'object' as const,
      properties: { confirmed: { type: 'boolean' as const, title: 'Confirm restart' } },
      required: ['confirmed'],
    },
  })
  if (elicit.action !== 'accept' || !elicit.content?.['confirmed']) {
    return okText('Gateway restart cancelled.')
  }

  const ctx = buildContext({ stack: input.stackName })
  const conn = await resolveConn(ctx)
  const { session, release } = await acquireSession(conn)
  try {
    // Reuse the version the host already runs. This path does NOT go through the
    // shared builder by accident of history: it hand-wrote its own run command and
    // so missed the v1.7.5 fix, leaving an agent calling clawops_gateway_restart
    // able to break a working deployment exactly as the CLI once did.
    const imgResult = await session.exec(IMAGE_INSPECT_CMD)
    const image = imageForRestart(imgResult.stdout)
    if (!image.ok) return errText(image.error)

    const result = await session.exec(
      gatewayRunCommand({ image: image.value, configPath: OPENCLAW_CONFIG }),
    )
    if (result.code !== 0) {
      return errText(`Gateway restart failed: ${result.stderr}`)
    }
    return okText('Gateway restarted successfully.')
  } finally {
    release()
    drainPool()
  }
}
