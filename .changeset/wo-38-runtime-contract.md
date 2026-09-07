---
"@clawops/cli": major
---

One runtime contract: every gateway container starts from the same builder, hardened, on loopback

`src/openclaw/runtime.ts` is now the only place a gateway container is started. Six
hand-written `docker run` strings — three restart paths, two provisioning templates and a
Pulumi component — became one builder with six callers.

That drift was not theoretical. The restart paths lost the gateway command entirely
(v1.7.5); the MCP tool missed that fix because it wrote its own (v1.7.6); the macOS branch
of the local bootstrap still carried a duplicated `--env-file`. Three incidents, one cause.
The systemd ExecStart line and the detached path are now provably the same command with
different supervision rather than two strings that merely look alike.

**The gateway is now published on the host's loopback only** — `127.0.0.1:18789`, not
`0.0.0.0:18789`. It is reached with `clawops tunnel` (which forwards to the host's
loopback and is unaffected) or a reverse proxy on the host. Previously a permissive
firewall rule would silently expose an HTTP gateway with no TLS. If you deliberately front
the gateway from another machine, that deployment now needs a proxy on the host.

**Container hardening**, adopted from the profile SP-06 observed on a live `openclaw fleet`
cell — a configuration upstream already runs OpenClaw under: `--cap-drop=ALL`,
`--security-opt no-new-privileges`, `--init`, `--pids-limit 512`.

Fleet's `--memory` and `--cpus` are deliberately not adopted by default. Those exist to
divide one host between tenants; clawops deploys single-tenant, where inheriting Fleet's
2 GB cap would shrink a large box rather than protect it. Both are opt-in.

The unused Pulumi `Gateway` component is deleted. Nothing constructed it, and it still
pointed at `ghcr.io/anthropics/openclaw`, a registry that does not exist.
