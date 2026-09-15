---
'@clawops/cli': patch
---

**The setup wizard checked a machine size the operator was not deploying.**

The wizard asks for a server size three questions before it runs the account preflight, and then
did not pass it. Azure offers SKU families per subscription, so the check cleared the provider
default and said nothing about the size actually chosen — a deploy the wizard called ready then
failed on an unavailable SKU. `clawops doctor --instance-type` already passed it; the wizard did
not.

**And a check clawops could not perform was counted as a failure.** `doctor` reports an
unanswerable check — a denied listing — as a warning. The wizard listed it among the failures,
which withheld "account is ready" from an account that may be perfectly set up, on the strength
of a question that was never asked. It now names what could not be checked and why, offers no
fix for it, and qualifies its verdict instead of contradicting it:

```
⚠ Could not check: Standard_D2s_v5 is available in eastus
    clawops could not list SKUs: AuthorizationFailed.
✓ azure account is ready, as far as clawops could tell.
```
