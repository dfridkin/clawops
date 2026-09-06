# Known Limitations

This document states what clawops does not do, where behavior is constrained, and what is planned
for future releases. These limitations are intentional design choices or deferred scope — they are
not bugs.

## Deployment topology

**Single-node deployments only.** clawops provisions one VM per stack and manages OpenClaw on that
VM. There is no built-in clustering, load balancing, or failover. For high availability, use
multiple stacks across regions and manage routing externally.

**Not a Kubernetes replacement.** clawops deploys to VMs. Container orchestration platforms are
out of scope for v1.

## Plan/apply semantics

**`clawops apply` is not an immutable plan execution.** `apply` re-runs `pulumi up` using the
parameters from the reviewed plan JSON — it does not replay a locked provider-level execution
artifact. Cloud state that changes between `plan` and `apply` will be reconciled by Pulumi against
live infrastructure, which may produce a different diff than the one you reviewed.

See [`docs/plan-apply.md`](plan-apply.md) for full semantics and drift guidance.

## OpenClaw version support

**This clawops line supports OpenClaw up to 2026.7.1-2 only.** OpenClaw 2026.8.1
("OpenClaw 2.0") changed the container runtime contract: sessions and credentials moved
into SQLite under a state directory this line does not mount, the config moved to a
writable path, and model providers became install-gated plugins. Deploying it from here
produces a crash-looping gateway. `doctor`, `plan`, `up` and `apply` refuse it.

For OpenClaw 2026.9.1 and later, use clawops 2.x. `clawops doctor --stack <name>` reports
the version a deployed gateway is actually running, so an existing deployment that
already picked up 2.0 through a moving tag can be identified.

**Moving tags are not accepted unresolved.** `latest` and `stable` both now point at
OpenClaw 2.0. clawops resolves a moving tag to a concrete release before checking it, and
refuses one it cannot resolve rather than assuming it is compatible. The default is a
concrete pin.

## Infrastructure scope

**clawops manages the host, not OpenClaw's internal configuration.** Deploying a stack provisions
a VM with Docker and OpenClaw installed. Configuring models, channels, agents, and skills is done
separately via `clawops config set` or the OpenClaw UI.

**clawops does not author or manage OpenClaw agents or skills.** It manages the infrastructure
those agents run on.

**Ollama and other host-local model runtimes are reached at `host.docker.internal`.**
OpenClaw runs in a container, so `localhost` there is the container rather than the host.
clawops passes `--add-host=host.docker.internal:host-gateway` and defaults the Ollama
address accordingly. The runtime must also listen on an address the container can reach
(`OLLAMA_HOST=0.0.0.0:11434 ollama serve`); one bound to `127.0.0.1` stays unreachable.

## Networking and TLS

**No TLS or domain automation in the current release.** The gateway runs on port 18789 without
TLS termination. Bring your own reverse proxy (nginx, Caddy, Cloudflare Tunnel) for HTTPS. TLS
automation is tracked in the roadmap.

**No Tailscale or VPN integration in v1.** The deploy-plan schema includes a `tailscale` field
(reserved for future use) but it is not yet implemented.

## Credentials and secrets

**Cloud credentials must be configured in your environment before using clawops.** They are never
stored in `~/.clawops/config.json`. clawops reads them from your existing cloud CLI profiles
(`AWS_PROFILE`, `gcloud ADC`, `AZURE_CLIENT_ID`, etc.).

**No automatic secret rotation.** Rotate secrets (gateway tokens, API keys) manually by updating
the value in your cloud secret store and running `clawops config set` or re-applying.

**`~/.clawops/config.json` stores no secrets**, but it does store connection metadata (host, SSH
key path, state backend URL). Protect it accordingly.

## Providers

**`clawops plan` and `clawops apply` are not supported for the local provider.** The local provider
bootstraps over SSH without a Pulumi state backend. Use `clawops up` directly.

**Provider support varies by capability.** See [`docs/providers/matrix.md`](providers/matrix.md)
for the full per-provider feature matrix — some capabilities (static IP, secret store, firewall
management) are cloud-specific.

## Platform

**No native Windows support.** WSL2 is fully supported. Native Windows requires POSIX path
semantics for the MCP server's working-directory invariants and is deferred to v1.1+. See
[`docs/support-matrix.md`](support-matrix.md).

## Monitoring and observability

**No built-in monitoring hooks in v1.** clawops can tail logs and check container status, but does
not set up Prometheus, Grafana, or alert routing. This is planned for a future release.

## Backup and restore

**Backups can be created but not restored by clawops on the 1.x line.** `clawops backup create`
works and verifies the archive it produces. `clawops backup restore` fails with an explanation:
OpenClaw up to `2026.7.1-2` ships `backup create` and `backup verify` only, so there is no restore
subcommand for clawops to call. Recovery is a manual procedure documented in
[`docs/backup-restore.md`](backup-restore.md#recovering-from-an-archive). OpenClaw 2.0 adds a real
restore that understands its SQLite state layout, and `clawops backup restore` returns in the
clawops 2.x line built on that.

Releases before v1.7.5 advertised this command, but it invoked `openclaw-ctl`, a binary that does
not exist in the OpenClaw image, so it never ran.

## Cost

**No cost estimate output.** clawops does not calculate or display estimated cloud costs before
provisioning. Check your provider's pricing calculator for the selected instance type and region.

## What is planned

The following limitations are tracked in the roadmap and expected to be addressed:

| Limitation | Roadmap milestone |
|---|---|
| TLS/domain automation | R4 — Production Operations |
| Deeper health checks | R4 — Production Operations |
| Upgrade/rollback workflow | R4 — Production Operations |
| Config validation command | R5 — Configuration and Secrets |
| Monitoring hooks | R4 — Production Operations (later) |
| Cost estimate output | R6 — Provider Reliability (later) |
| `backup restore` | clawops 2.x, on OpenClaw 2.0's restore subcommand |

See [`docs/roadmap.md`](roadmap.md) for the full adoption roadmap.
