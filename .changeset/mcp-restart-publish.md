---
'@clawops/cli': patch
---

**`clawops_gateway_restart` keeps a gateway reachable where it was.** The MCP tool rebuilt the
gateway's run command itself, with the default publish scope, so an agent restarting a stack
deployed with `--publish-gateway all` took the gateway off every interface but loopback. It now
uses the same restart as the CLI and plan apply, which reads the scope off the running container
and waits for the gateway to answer before calling the restart done.
