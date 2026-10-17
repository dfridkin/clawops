// The guardrail, checked against the gateway's configuration as it is now.
//
// Read on every tool call, not once at start. OpenClaw's layout fails open: an agent added
// after install gets the clawops tools unless it is denied too, and a binding added with
// `openclaw agents bind` takes effect without a restart (SP-13). The server cannot see which
// agent is calling, so it re-reads openclaw.json each time and refuses every call while any
// condition fails. It is a local file read on the host.

import type { HostAgentConfig } from './config.js'
import { checkGuardrail, type GuardrailResult } from './guardrail.js'

export type GatewayConfigReader = () => Promise<Record<string, unknown>>

async function readLocalGatewayConfig(): Promise<Record<string, unknown>> {
  const { acquireSession } = await import('../transport/pool.js')
  const { readRemoteConfig } = await import('../plan/remote-config.js')
  const { HOST_AGENT_CONN } = await import('../transport/conn.js')
  const { session, release } = await acquireSession(HOST_AGENT_CONN)
  try {
    return await readRemoteConfig(session)
  } finally {
    release()
  }
}

let reader: GatewayConfigReader = readLocalGatewayConfig

/** For tests: answer with a fixed config instead of reading the host's. */
export function setGatewayConfigReaderForTests(r?: GatewayConfigReader): void {
  reader = r ?? readLocalGatewayConfig
}

/** Whether the guardrail holds right now. A config that cannot be read does not hold. */
export async function currentGuardrail(agent: HostAgentConfig): Promise<GuardrailResult> {
  let config: Record<string, unknown>
  try {
    config = await reader()
  } catch (err) {
    return {
      ok: false,
      failures: [`The gateway configuration could not be read: ${err instanceof Error ? err.message : String(err)}`],
    }
  }
  return checkGuardrail(config, { agentId: agent.agentId, operators: agent.operators })
}
