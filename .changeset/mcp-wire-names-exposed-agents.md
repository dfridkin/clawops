---
"@clawops/cli": patch
---

`clawops mcp wire` and the setup wizard now name every gateway agent that can call clawops once wired, the default agent included, and say how to deny one. OpenClaw offers a gateway's MCP servers to every agent unless that agent's `tools.deny` covers `clawops__*`.
