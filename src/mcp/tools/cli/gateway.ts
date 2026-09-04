// clawops_gateway_restart handler

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { GatewayRestartInput } from '../_generated.js'
import { buildContext } from '../../../cli/context.js'
import { acquireSession, drainPool } from '../../../transport/pool.js'
import { resolveConn, okText, errText } from '../_conn.js'

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
    // Preserve current image version
    const imgResult = await session.exec(
      `docker inspect openclaw --format '{{.Config.Image}}' 2>/dev/null || echo 'ghcr.io/openclaw/openclaw:stable'`,
    )
    const image = imgResult.stdout.trim()
    // Must mirror the CLI restart path (src/cli/commands/gateway.ts). Before v1.7.2
    // this dropped the config bind-mount entirely, so restarting through MCP silently
    // reverted the gateway to defaults — and would now also undo config delivery.
    const cmd = [
      'docker stop openclaw 2>/dev/null || true',
      'docker rm   openclaw 2>/dev/null || true',
      `docker run -d --name openclaw --restart unless-stopped -p 18789:18789 ` +
        `-e OPENCLAW_CONFIG_PATH=/app/config.json --add-host=host.docker.internal:host-gateway ` +
        `-v /home/clawops/openclaw.json:/app/config.json:ro ${image}`,
    ].join(' && ')
    const result = await session.exec(cmd)
    if (result.code !== 0) {
      return errText(`Gateway restart failed: ${result.stderr}`)
    }
    return okText('Gateway restarted successfully.')
  } finally {
    release()
    drainPool()
  }
}
