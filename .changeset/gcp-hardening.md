---
'@clawops/cli': patch
---

`clawops harden` gains three GCP checks, so the hardening report is no longer AWS-only on the
cloud side.

- **VPC firewall audit** reports any ingress rule on a clawops network that admits `0.0.0.0/0`
  or `::/0`, naming the port and saying when it is SSH or the gateway.
- **Shielded VM** reports whether Secure Boot, vTPM and integrity monitoring are on.
- **OS Login** reports whether it is enabled.

All three are check-only, and the last two are check-only for reasons worth stating. Shielded VM
settings cannot be changed while the instance is running, and clawops will not stop a gateway in
order to harden it. Enabling OS Login makes the instance ignore metadata SSH keys, which is the
key clawops authenticates with: every day-two command would stop working. A hardening step whose
success locks the operator out is not one clawops will take, so it reports the posture and leaves
the decision where it belongs.

A check that cannot be performed reports as skipped, naming what was missing, rather than as a
pass.
