---
"@clawops/cli": patch
---

`clawops doctor` checks Tailscale (WO-34). On a host that has Tailscale it reports whether the host is on its tailnet and when its node key expires, and warns when that is within 14 days: an expired key takes the host off the tailnet. On a stack clawops reaches over its tailnet (`clawops harden --tailscale`) those are failures, and a **Tailnet address** check confirms clawops reached the host at the address it recorded. When such a stack does not answer at all, doctor says it is reached only over the tailnet and that an expired key is one reason why. A host logged out of its tailnet gets the command that rejoins it without moving clawops onto it: `clawops harden --options tailscale`.
