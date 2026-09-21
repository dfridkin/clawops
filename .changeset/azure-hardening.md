---
'@clawops/cli': patch
---

**`clawops harden` gains four Azure checks (WO-32), so the hardening report covers all three
clouds rather than AWS and GCP only.**

- **NSG audit** reports any inbound Allow rule on a clawops network security group that admits
  the whole internet, naming the port and saying when it is SSH or the gateway. Azure spells
  "anywhere" four ways — `*`, the `Internet` service tag, `0.0.0.0/0` and `::/0` — and `*` is
  what the portal writes by default, so all four count.
- **Disk encryption** reports the gap beyond Azure's default rather than the default itself.
  Every managed disk is encrypted at rest with a platform key and cannot be otherwise, so the
  check reports whether encryption at host is on and whether the key is yours.
- **Defender for Cloud** reports which relevant plans are on the free tier, which reports
  recommendations and protects nothing.
- **JIT VM access** reports whether a policy covers the clawops VM, and says when the read
  failed because Defender for Servers Plan 2 is absent rather than leaving it ambiguous.

All four are check-only, each for a stated reason: NSG rules are written from the plan and would
be undone by the next apply; encryption at host needs the VM deallocated; Defender is billed per
resource per month, so clawops will not put a recurring charge on a subscription; and JIT needs
the paid plan and takes the NSG rules over from the plan that wrote them.

A read that fails says why, because the fixes differ. Against a live subscription the Defender
read returned 404 "Subscription Not Registered", and reporting that as a missing permission
would send an operator to check RBAC when the fix is one `az provider register`. A 403 is
reported as a permission; a 404 naming registration names the provider to register.

JIT does not read an empty list as a definite negative. With `Microsoft.Security` unregistered,
`jitNetworkAccessPolicies` answers 200 with an empty list while `pricings` under the same
namespace answers 404, so the check confirms the provider is registered before concluding that
no policy covers the VM.

Resources are matched on their own name, never on their ARM id. An id carries the resource
group, and clawops names that group `clawops-<stack>`, so matching the id would mark every
resource in the group as ours.
