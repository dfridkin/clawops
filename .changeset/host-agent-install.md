---
"@clawops/cli": minor
---

`clawops agent install` puts a host agent on a stack's gateway host: clawops serving one OpenClaw agent that only the operator can reach. It refuses before writing anything unless the gateway's routing allows only the operator. It then denies clawops to every other agent and checks the gateway kept those entries. Only then does it install a pinned, checksum-verified Node runtime and the operator's own clawops build, start `clawops-agent.service` on the Docker bridge, and wire the gateway to it. `--allow` names the destructive tools the agent may hand off; `--strict` also refuses while any other agent can act inside the gateway container. `clawops agent uninstall` removes it. `clawops harden` now keeps the host agent's firewall rule when it resets ufw.
