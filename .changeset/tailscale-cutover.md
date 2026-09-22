---
'@clawops/cli': patch
---

**A stack can move onto its tailnet, close its public ports, and move back (WO-34, steps 4–6 and
revert).**

- **`clawops harden --tailscale`** joins the tailnet, then proves the new address works before
  clawops uses it. First it pins the host's keys for the tailnet address, read over the public
  connection that is already trusted. Then it opens a fresh SSH session to that address. Only if
  the session succeeds is the address recorded, and from then on every connection clawops makes
  to the stack goes there. The stack joins under its own name, `clawops-<stack>`, not the host's.
- **`clawops plan --private-only`** writes a plan with no public SSH or gateway rules, and
  `clawops apply` closes the ports at the cloud firewall. Both refuse unless this machine can
  reach the stack over the tailnet at that moment. Apply checks again because the tailnet can
  drop between review and apply. Apply also refuses a plan made for an address the stack no
  longer has. This goes through the plan instead of `harden` because clawops keeps no stack
  config between runs, so an update started from `harden` would run with default settings and
  could replace the instance (ADR 0013).
- **`clawops harden --tailscale-revert`** takes the host off the tailnet over its public
  address. Run over the tailnet, the command cuts its own connection, which hung for eight
  minutes on AWS. It then forgets the tailnet host key and points clawops back at the public
  address. On a private-only stack it refuses and prints the plan and apply commands that
  reopen SSH first.
- **`clawops destroy`** now forgets the host keys for both addresses of a stack on its tailnet.
  It used to forget only the tailnet key, leaving the public address pinned for an instance
  that no longer existed, on an address the cloud reassigns.

`clawops doctor` doesn't yet report tailnet status. Local stacks can join and repoint but have
no private-only mode, because they have no plan/apply path.
