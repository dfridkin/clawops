// The host agent's entry point: `node host-agent.mjs --http <port> --bind <addr>`.
//
// Built as one self-contained file (tsup.config.ts) that `clawops agent install` copies to the
// gateway host with the spec/ directory beside it. Nothing is installed from npm on the host,
// so what runs there is exactly the operator's own clawops, at the operator's version.
//
// The token is read from CLAWOPS_MCP_TOKEN, which the unit's EnvironmentFile sets, so it never
// appears in a process listing.

import { parseArgs } from 'node:util'
import { serveMcp } from '../mcp/server.js'

const { values } = parseArgs({
  options: { http: { type: 'string' }, bind: { type: 'string' } },
  strict: true,
})

serveMcp({
  hostAgent: true,
  port: values.http ? Number(values.http) : undefined,
  bind: values.bind,
}).catch((err: unknown) => {
  process.stderr.write(`[clawops] ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
