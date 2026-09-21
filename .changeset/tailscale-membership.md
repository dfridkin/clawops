---
'@clawops/cli': patch
---

**`clawops harden` can put a host on your tailnet (WO-34, first part).**

A new `tailscale` module installs Tailscale if it is absent, joins the tailnet, and reports the
address it was given. It is off by default: every other module hardens a host that is already
reachable, and joining a network the operator has to own an account on is not something to do
as part of a `clawops harden` with no arguments.

The auth key comes from `clawops secret set TAILSCALE_AUTH_KEY` and nowhere else, so a key never
reaches a terminal scrollback or a CI log. Getting it to the host without exposing it takes two
separate measures, because there are two separate exposures. It is passed to `tailscale up`
through a file rather than an argument, so it is not in that process's argv; and it travels to
the host over the SSH data channel as stdin rather than inside the command string, because sshd
runs whatever string it is given as `$SHELL -c '<string>'` and every byte of that lands in the
outer shell's argv. The staged file is created under `umask 077` rather than chmod-ed afterwards,
and a trap removes it even if the command is interrupted. Anything shown after a failure has the
key stripped from it.

`RemoteExec` gains an optional `stdin`, routed to the transport's existing `execWithInput`, so
any hardening module that needs to hand a secret to a host has a way that does not put it in a
command line.

What this does not do yet, and deliberately: it does not rewrite clawops config to use the
Tailscale address, and it does not remove public access. Those are the steps of WO-34 that can
leave an operator unable to reach their own machine, and they need the verification this
module's output makes possible.

The address is checked against 100.64.0.0/10 rather than taken on trust, because `tailscale ip
-4` prints nothing on a host that is not up, and an empty string arriving at a config rewrite as
"the new SSH host" is a lockout.
