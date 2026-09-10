---
"@clawops/cli": patch
---

**`clawops mcp wire` never wired anything, and the MCP HTTP server had no authentication.**

Both are bug fixes, but one of them will stop a server that starts today. Read the second
section before upgrading if you run `clawops mcp serve --http`.

## `mcp wire` wrote a key OpenClaw does not have

It wrote `gateway.mcpClients`. That key does not exist in OpenClaw — verified against the
config schemas of `2026.4.5`, `2026.7.1-2` and `2026.9.2`. The real key is top-level
`mcp.servers`. Nothing on this line validated the write, so clawops stored a key nothing
read, restarted your gateway, and reported:

> The gateway's AI can now run clawops commands.

It could not. The entry also used `command: "clawops"` over stdio, which spawns inside the
gateway container — where clawops is not installed and nothing installs it. So even the right
key would not have worked.

It now delegates to `openclaw mcp add`, which **probes the server before saving**. "Wired"
means the gateway connected, not that a file was written; a failed probe prints the reason
and changes nothing. Use `--rewire` to replace an existing entry.

If your gateway's OpenClaw has no `mcp add` — `2026.4.5` ships `openclaw mcp` with only
`list` and `serve` — clawops says so and names the version to upgrade to. That is asked of
the binary, not inferred from a version string.

**You have to run the server yourself.** clawops is not installed on the gateway host:

```bash
clawops mcp serve --http 18790 --bind 0.0.0.0 --token "$(openssl rand -hex 16)"
clawops mcp wire --stack prod --token <same token>
```

## `mcp serve --http` now requires a token off loopback — this may stop your server

The HTTP server had **no authentication of any kind** while exposing every clawops tool,
`clawops_destroy` included. Bound to anything but loopback it was an unauthenticated control
plane for your cloud account, reachable by anyone the firewall admitted.

It now requires a bearer token, compares it in constant time, and **refuses to start** when
bound off-loopback without one:

```
Refusing to serve MCP on 0.0.0.0 without a token. This server exposes every clawops tool,
including destructive ones, and has no other authentication.
```

**If you run `clawops mcp serve --http --bind <anything but 127.0.0.1>`, it will not start
after this upgrade** until you pass `--token` (or set `CLAWOPS_MCP_TOKEN`). That is a
breaking change in a patch release, made deliberately: continuing to serve an unauthenticated
destructive surface is the worse outcome.

## `mcp serve --http` also only ever served one client

It built one transport for the whole process, so the first client to connect claimed it and
every later one — a second editor, a reconnect, a probe — was answered `"Server already
initialized"`. HTTP mode is the multi-client mode. It now creates one session per client.

Backported from clawops 2.0 (WO-61).
