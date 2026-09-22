# ADR 0013, Private-only goes through the plan, not `harden`

**Status:** Accepted
**Date:** 2026-09-22
**Deciders:** maintainer
**Revisit:** if clawops starts persisting stack config between runs, or when `local` stacks get a private-only mode

## Context

WO-34 step 6 (SPEC.md §15) says `clawops harden --tailscale --private-only` removes the public
SSH and gateway rules itself: a Security Group change on AWS, deleting firewall resources "via
Pulumi update" on GCP, an NSG change on Azure.

It can't do that safely. clawops keeps no Pulumi stack config between runs. The workspace is
ephemeral (ADR 0010), and every `up` rebuilds stack config from a deploy plan
(`src/plan/stack-config.ts`). An update started from `harden` has no plan, so it would run with
each program's defaults. A different default instance type means a replaced instance, and the
boot disk goes with it. Editing the cloud firewall through the SDK is no better. Pulumi would
see drift and put the rules back on the next apply.

Closing ports is also a change to infrastructure. The project invariant (F5–F6) is that such
changes are emitted as a plan, persisted, reviewed, then applied.

## Decision

- **`clawops plan --private-only`** emits a plan with empty `allowedSshCidrs` and
  `allowedGatewayCidrs`, plus `network.tailscale: { enabled, privateOnly: true, ip }`. It refuses
  in three cases:
  - The stack has no verified tailnet address (`harden --tailscale` writes one only after
    reaching it).
  - It is combined with `--ssh-cidr` or `--gateway-cidr`.
  - This machine cannot open an SSH session to the tailnet address now.
- **`clawops apply`** re-checks every one of those claims before touching the stack. The plan
  file is editable JSON, so apply doesn't trust it. It also refuses a plan made for a tailnet
  address the stack no longer has. The check lives in `applyPlan`, so the MCP `apply`, `up` and
  `deploy_app` paths get it too. After `up`, apply records `privateOnly` on the stack's tailnet
  override, and applying an ordinary plan clears it.
- **`clawops harden --tailscale-revert`** runs over the *public* address
  (`buildContext({ ignoreTailnet: true })`):
  1. Probe the public address.
  2. Run `tailscale logout` on the host.
  3. Drop the override and forget the tailnet host key.

  On a private-only stack the public address doesn't answer. Revert then prints the plan and
  apply commands that reopen SSH, and changes nothing. Reopening is an infrastructure change
  like closing was, so it goes through a plan too.

  Revert uses `logout`, not the spec's `tailscale down`. `down` leaves the node in the admin
  console holding its name, so the next join would get a suffixed name.

## Consequences

**Positive:**
- The port closes at the cloud firewall. The operator reviews a diff that shows the rule
  removals, the same as any other change.
- No path closes public access without a live proof that the tailnet reaches the host, taken
  immediately before the change.
- A later `apply` of an old public plan reopens the ports visibly and records that it did.
  Nothing drifts silently.

**Negative:**
- Private-only is two commands, not one flag on `harden`.
- A private-only stack must be reopened with a plan before it can leave the tailnet.
- `local` stacks have no plan/apply path, so they get no private-only mode. The spec's UFW rule
  for local hosts isn't implemented; see `docs/limitations.md`.

## Rule deviation

This departs from the WO-34 text in SPEC.md, not from a numbered rule.
SPEC.md §15 WO-34 has been rewritten to match.
