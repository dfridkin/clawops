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

**Gateway auth token.** A fresh local bootstrap could not start a gateway at all: OpenClaw
refuses a non-loopback bind without auth, and the bootstrap never supplied a token, so the
container exited 78 and systemd restart-looped. A token is now generated once and passed
via a 0600 env file — never on argv.

**Packaging.** `spec/` was missing from the published files and both it and
`bootstrap.sh.tmpl` were unresolvable from the bundle, so `clawops plan` and `clawops up`
(local) failed from an installed package. All three are now shipped and resolved correctly.

**SSH host-key verification.** The verifier read `parts[1]` of each `known_hosts` line as
the key, but in OpenSSH format that field is the key *type* — so any standard entry failed
permanently with `Host denied (verification failed)`. It only worked against clawops's own
two-field hex format, and would have corrupted `~/.ssh/known_hosts` if pointed at one.
Standard entries now parse, including comma-separated host lists, `[host]:port`, hashed
hostnames, `@revoked` / `@cert-authority` markers, and wildcard and negated patterns.
Legacy hex entries are still accepted; new entries are written in standard format.

⚠️ **Behaviour change:** a host covered by a wildcard whose key does not match is now
refused where it previously connected. Ignoring wildcards meant trust-on-first-use
accepted a key the operator's own file contradicted; matching them turns that into the
refusal it should be. This matches OpenSSH, and was cross-checked against `ssh` directly.
