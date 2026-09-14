---
'@clawops/cli': patch
---

**`clawops plan` could not say who is allowed to connect.**

The deploy-plan schema has carried `network.allowedSshCidrs` since the beginning and the setup
wizard fills it, but the non-interactive command had no flag for it and fell through to:

```ts
const network = intent.network ?? { allowedSshCidrs: [], allowedGatewayCidrs: [] }
```

So every plan generated outside the wizard described a host that admits nothing — including
clawops itself, whose `ssh`, `logs`, `tunnel` and `harden` all run over SSH.

`plan` now takes `--ssh-cidr`, `--gateway-cidr` and `--publish-gateway`. `--ssh-cidr auto`
resolves this machine's public IP to a `/32` **while the plan is generated**, so the plan
records the address it admits rather than deferring the question to apply time. A bare IP is
refused rather than assumed to be a `/32`, and a failed `auto` lookup stops the plan rather
than falling back — neither an empty list nor `0.0.0.0/0` is a safe guess.

Deny-all remains the default (N10). A plan that admits nobody is still valid, and now says so:

```
[clawops] warning: network.allowedSshCidrs is empty, so this deployment will accept no SSH
connections at all …
```
