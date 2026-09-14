---
"@clawops/cli": patch
---

**Bedrock never worked, and the config the setup wizard wrote was invalid for every provider.**

## The wizard wrote a shape OpenClaw does not have

```jsonc
"models": { "provider": "bedrock", "modelId": "anthropic.claude-sonnet-4-6" }
```

The schema's key is `models.providers.<id>`. Validation rejected the old form outright —
`unknown key "provider"` — so this affected **every** provider, not just Bedrock.

Worse, `requiredPlugins` reads `models.providers` to decide which plugins to install. With the
wrong key it found nothing, so the plugin for whichever provider you chose was never
installed — and on Bedrock an uninstalled provider plugin exits the gateway **78**.

## Bedrock needed two things nobody had set

**The transport.** Bedrock is a plugin provider, and unlike bundled ones it does not resolve
its own — without `api: "bedrock-converse-stream"` every call routed through the
OpenAI-compatible transport and died on *"requires an explicit base URL"*.

**An inference profile.** Bedrock refuses bare foundation-model ids for on-demand inference:

```
Invocation of model ID anthropic.claude-haiku-4-5-... with on-demand throughput isn't
supported. Retry your request with the ID or ARN of an inference profile...
```

All ten Bedrock models in the catalog were bare ids. The usable id — `us.anthropic.…` — is
region-dependent, so clawops now resolves it against the deployment region at plan time and
records the concrete profile in the plan. It prefers your own geography, falls back to a
`global.` profile, and **refuses rather than routing inference to another continent**.

This needs `bedrock:ListInferenceProfiles` on the identity running `clawops`.

Verified end to end against real Bedrock.
