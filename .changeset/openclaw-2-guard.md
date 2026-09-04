---
"@clawops/cli": patch
---

Refuse OpenClaw 2.0, and fix config delivery

**Version ceiling.** `spec/openclaw-versions.yaml` declared no upper bound and, more
importantly, was read by no code — so clawops accepted any OpenClaw release, including
2.0. Deploying 2.0 from this line produces a crash-looping gateway (exit 78) and, with
no state volume mounted, destroys sessions and credentials on every restart. `doctor`,
`plan`, `up` and `apply` now refuse anything above 2026.7.1-2 and point at clawops 2.x.

**Moving tags are resolved before the range check**, and an unresolved tag is refused
rather than assumed safe. The default OpenClaw version is now a concrete pin instead of
`stable`/`latest` — both of which now resolve to 2.0.

**`doctor` reports the deployed version**, because refusing future operations does
nothing for someone who already deployed 2.0 with a moving tag.

**Config delivery.** `clawops config set` has never applied: the mounted config was read
by nothing on either OpenClaw line. Setting `OPENCLAW_CONFIG_PATH` fixes it, guarded by
port normalisation, an argv `--port` pin, and a parse check. The MCP `gateway restart`
tool, which dropped the config mount entirely, now mirrors the CLI path.

**Ollama** now defaults to `host.docker.internal` and clawops passes
`--add-host=host.docker.internal:host-gateway`, so a host-side Ollama is reachable from
the container for the first time.
