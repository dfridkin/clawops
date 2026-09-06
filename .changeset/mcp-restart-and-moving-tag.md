---
"@clawops/cli": patch
---

Fix the MCP gateway restart, and stop restarts falling back to an unsupported version

**`clawops_gateway_restart` broke deployments in the way v1.7.5 fixed everywhere else.**
The MCP tool hand-wrote its own `docker run` and so was missed by that consolidation: it
started the container with no gateway command, losing `--allow-unconfigured`, the port pin
and the auth token. An agent calling this tool left a crash-looping gateway. It now uses the
same builder as the CLI, which the test suite enforces rather than assumes.

**Restarts no longer fall back to `latest` or `stable`.** All three restart paths reused the
image the host was already running — correct — but fell back to a moving tag when
`docker inspect` found no container. Both tags now resolve to OpenClaw 2.0, which this
release line refuses to deploy, so the fallback pushed an unsupported version past the very
guard added in v1.7.2 to stop it. With no container there is nothing to reuse, so clawops
now says so and points at `clawops up --openclaw-version <version>`.
