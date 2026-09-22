---
'@clawops/cli': patch
---

The published package now carries its license, keywords and issue tracker, so npm shows what
clawops is and searches for "openclaw", "mcp-server" or "pulumi" can find it. The repository also
ships a Dockerfile and a `glama.json`, which is what the Glama MCP directory needs before it will
list a server rather than withhold it.
