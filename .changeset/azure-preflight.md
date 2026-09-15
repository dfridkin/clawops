---
'@clawops/cli': patch
---

**A fresh Azure subscription fails partway through a deploy, and nothing said so.**

Azure registers resource providers per subscription, and a new one has none:

```
Microsoft.Compute: NotRegistered
Microsoft.Network: NotRegistered
Microsoft.Storage: NotRegistered
```

The first sign was ARM refusing mid-deploy with `The subscription is not registered to use
namespace 'Microsoft.Compute'` — the Azure counterpart of GCP's disabled-API failure, which
`gcpPreflight` has checked since 2.0. Azure had no preflight at all.

`clawops doctor --provider azure` now checks the subscription resolves, that Compute, Network
and Storage are registered — offering to register them, naming the subscription it will change
— and that the azblob state backend is configured.

That last one is the check that looks least like its cause: **Pulumi's azblob backend does not
use your `az login`.** It authenticates with `AZURE_STORAGE_ACCOUNT` plus a key or SAS token,
so every credential check can pass and a deploy still fail to open its own state.
