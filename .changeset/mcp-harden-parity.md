---
'@clawops/cli': minor
---

**Hardening, including the Tailscale flows, is reachable through MCP.** A new `clawops_harden`
tool applies hardening modules, joins a stack to a tailnet and moves clawops onto that address,
or takes it back off. `clawops_plan` gains the flags that decide who can reach a deployment:
`sshCidr`, `gatewayCidr`, `publishGateway`, `openclawVersion` and `privateOnly`.

Without these, the feature this release is named for could not be reached by an agent at all,
and every plan an agent generated described a host nothing could connect to — deny-all is the
right default, but a plan that cannot say otherwise is not a plan. `instanceType` also accepts
the provider-native machine types the CLI has always taken, instead of only the five clawops
aliases.

The refusals travel with the capability. Both surfaces call the same flows, so an agent asking
to leave the tailnet on a private-only stack gets the operator's refusal — and the plan and
apply commands that reopen SSH first — rather than a way around it.

**The audit log called every refusal a success.** A tool reports failure by returning
`isError`, not by throwing, and the audit wrapper classified only the throw — so a declined
destroy and a completed one were indistinguishable in the log R21 exists to produce. It now
reads the returned result.

Four tool descriptions named tools that do not exist (`clawops_ssh`, `clawops_agents_logs`,
`clawops_gateway_update`, `clawops_gateway_stop`), so an agent following the advice in a
"use X instead" line got a tool-not-found. They now name a real tool or say plainly that none
exists. A test fails on any future description that points at a tool that is not served, and
another fails on any CLI command that has neither a tool nor a written reason it needs none.

`pnpm verify:mcp` drives the built server over stdio — the tool list a client receives, the
annotations on it, the confirmation a destructive tool raises, and the rule that stdout carries
protocol and nothing else — and runs in CI beside the packed-tarball check.
