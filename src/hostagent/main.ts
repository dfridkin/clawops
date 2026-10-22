// The host agent's entry point: `node host-agent.mjs --http <port> --bind <addr>`.
//
// Built as one self-contained file (tsup.config.ts) that `clawops agent install` copies to the
// gateway host with the spec/ directory beside it. Nothing is installed from npm on the host,
// so what runs there is exactly the operator's own clawops, at the operator's version.
//
// The token is read from CLAWOPS_MCP_TOKEN, which the unit's EnvironmentFile sets, so it never
// appears in a process listing.
//
// `--peer-call` is the same build run as a child, as clawops-peer, for one peer query (ADR 0015).

import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: { http: { type: 'string' }, bind: { type: 'string' }, 'peer-call': { type: 'boolean' } },
  strict: true,
})

const fail = (err: unknown): never => {
  process.stderr.write(`[clawops] ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
}

if (values['peer-call']) {
  // One peer query, run by the host agent as clawops-peer (peer-client.ts). Not a server.
  import('./peer-client.js').then((m) => m.peerCallMain()).catch(fail)
} else {
  import('../mcp/server.js')
    .then(({ serveMcp }) => serveMcp({ hostAgent: true, port: values.http ? Number(values.http) : undefined, bind: values.bind }))
    .catch(fail)
}
