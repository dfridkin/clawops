---
'@clawops/cli': patch
---

**clawops refused an `az login` it was about to rely on.**

The Azure credential check accepted only a service principal, OIDC, or a managed identity:

```
No Azure credentials found. Set AZURE_CLIENT_ID + AZURE_TENANT_ID + AZURE_CLIENT_SECRET …
```

Pulumi's `azure-native` provider falls back to the Azure CLI when none of those are set, so
`az login` was enough to deploy and not enough to pass `clawops doctor` — the same shape as the
GCP check that told operators to run `gcloud config set project` and then ignored the result.

clawops reads the CLI's own `azureProfile.json` now (honouring `AZURE_CONFIG_DIR`), the way the
GCP adapter reads Application Default Credentials off disk. The subscription a deploy lands in
resolves as `ARM_SUBSCRIPTION_ID`, then `AZURE_SUBSCRIPTION_ID`, then the CLI's default —
Pulumi's own order, so `doctor` reports what `apply` will use.

**`clawops doctor --provider <name>` now exists.** `docs/providers/azure.md` has documented that
flag from the beginning and there was no such flag: the only way to ask "am I set up for
Azure?" was to register a stack first and read the answer off a check about something else. It
works with or without a stack.
