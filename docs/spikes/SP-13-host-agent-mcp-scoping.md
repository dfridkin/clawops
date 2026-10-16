# SP-13: Scoping clawops' MCP tools to one OpenClaw agent

**Date:** 2026-10-16
**Image:** `ghcr.io/openclaw/openclaw:2026.9.2` (pinned)
**For:** WO-62 (2.4), the operator-only guardrail in
[`docs/security/host-agent-disclosure-review.md`](../security/host-agent-disclosure-review.md)

## Question

`mcp.servers` in `openclaw.json` is defined once, gateway-wide. ADR 0014 and the disclosure review
need the clawops tools to reach exactly one agent, the operator's. Can OpenClaw do that, and how?

## Setup

The setup ran on a Docker network:

- **The gateway**, with three agents (`main` as the default, `ops` and `third`) and a fake
  OpenAI-compatible model.
- **The real clawops MCP server**, built from `main` and serving with `mcp serve --http 18790
  --token …`.
- **Wiring** through `openclaw mcp add clawops --transport streamable-http`, which is what
  `clawops mcp wire` runs.

The fake model logged the tool names each request offered, and called `clawops_status` when it
was offered.

## Findings

1. **MCP tools are named `<server>__<tool>`**, for example `clawops__clawops_status`. The bridge
   also adds `clawops__prompts_list`, `clawops__prompts_get`, `clawops__resources_list` and
   `clawops__resources_read`.
2. **By default every agent gets every tool**, including the default agent.
   - All 30 tools plus the 4 bridge tools were offered to `main`, `ops` and `third` alike.
   - **This applies to `clawops mcp wire` today.** Wiring clawops into a gateway exposes it to
     every agent on that gateway, including the one that answers unrouted traffic.
3. **A per-agent deny removes them.** Setting `agents.entries.<id>.tools.deny` to
   `["clawops__*"]` dropped all 34 tools from that agent's requests, the bridge tools included.
   The change applied without a restart.
4. **A gateway-wide deny cannot be reopened for one agent.** With `tools.deny: ["clawops__*"]`
   set, `agents.entries.ops.tools.alsoAllow: ["clawops__*"]` gave `ops` nothing back, so a deny
   beats an allow. The fail-closed layout (deny everywhere, allow one agent) is therefore not
   available.
5. **The working layout** is to deny `clawops__*` on every agent except the host agent. In this
   layout `main` and `third` were offered no clawops tools, while `ops` was offered all of them
   and called `clawops_status` successfully end to end.
6. **The server cannot tell which agent called it.** Nothing in the request identifies the
   agent, so the server cannot refuse one agent and serve another.

## Consequences for 2.4

- **New agents are exposed by default.** The layout fails open: an agent added later receives
  the clawops tools unless it is denied too. The server therefore re-reads `openclaw.json` on
  every tool call. This is a local file read on the host. If any agent other than the host agent
  lacks the `clawops__*` deny, the server **refuses every call**, because it cannot tell which
  agent is asking (finding 6). This makes the guardrail fail closed at the server even though
  OpenClaw's layout fails open.
- **`agent install` writes the deny entries**, then verifies them the same way the server does.
- **`tools.toolsBySender`** exists per agent and could narrow `ops` further, to the operator's
  sender ID. It was not exercised here and is not needed while bindings already restrict who
  reaches `ops`. It is a candidate for later defence in depth.
- **For `clawops mcp wire` outside host-agent mode** (finding 2): the operator's wiring should
  at least warn that every agent on the gateway can now call clawops. This is a separate fix
  that can land in 2.4 or earlier.
