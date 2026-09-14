# SP-12 — What Bedrock actually needs in `openclaw.json`

**Status:** COMPLETE — 2026-09-13. Local Docker against `ghcr.io/openclaw/openclaw:2026.9.2`,
plus real Bedrock inference from AWS account `064318812234` (three Haiku calls, well under $0.01).

**Verdict: the auth shape SP-08 asked about does not matter. Two other things do, and clawops
gets both wrong today.**

## The question this spike was asked

SP-08 verified `auth.profiles.<id>.mode: "aws-sdk"` on 2026.9.1 and called the provider-block
`auth: "aws-sdk"` marker obsolete. The 2026.9.2 schema accepts **both**, so WO-64 needed to know
which one to write.

Answer: **neither is load-bearing.** What matters is the transport and the model ID.

## Finding 1 — `api: "bedrock-converse-stream"` is required

Without it, the provider is routed through the OpenAI-compatible transport and every call fails:

```
[openai-transport] [responses] error provider=amazon-bedrock api=openai-responses
message=Provider "amazon-bedrock" requires an explicit base URL before using an
OpenAI-compatible API. Reload provider metadata or configure an endpoint.
```

`api` is an enum on both the provider block and each model entry. The Bedrock value is
`bedrock-converse-stream`. clawops sets neither.

## Finding 2 — model IDs must be inference profiles, not foundation models

With the transport fixed, Bedrock itself rejects a bare foundation-model ID:

```
Validation error: Invocation of model ID anthropic.claude-haiku-4-5-20251001-v1:0 with
on-demand throughput isn't supported. Retry your request with the ID or ARN of an
inference profile that contains…
```

The working ID is the cross-region inference profile — `us.anthropic.claude-haiku-4-5-20251001-v1:0`.
**All ten Bedrock models in `spec/models.yaml` are bare IDs**, so every one of them would fail
this way. `aws bedrock list-inference-profiles` shows `us.`, `eu.`, `apac.` and `global.`
variants, which means the prefix is **region-dependent** and cannot be hardcoded to `us.`.

## Finding 3 — the provider needs an explicit `models[]` array

With no `models[]`, `openclaw models list` shows nothing for the provider and there is no model
to select. With one, the model appears and is chosen as the default:

```
amazon-bedrock/anthropic.claude-sonnet-4-6  text  200k  no  yes  default
```

## Finding 4 — the auth declaration changes nothing

Measured three ways, with the transport correct:

| Config | Reached Bedrock? |
|---|---|
| `auth: "aws-sdk"` in the provider block | yes |
| top-level `auth.profiles` (SP-08's shape) | yes |
| no auth declared at all | yes |

Credentials resolve through the standard AWS SDK chain at call time, not from anything in the
config. SP-08's shape was verified on a working gateway, so it was never wrong — it just was not
the part doing the work.

**Recommendation:** write `auth: "aws-sdk"` in the provider block anyway. It is one key, it
validates, it is local to the provider it describes, and it documents the intent for anyone
reading the config. But do not treat it as the fix.

## Finding 5 — startup is blocked by the missing plugin, not by config shape

All three shapes started cleanly and served `/startupz`. SP-08's Finding 2 stands, and is
narrower than it reads: it is the **uninstalled plugin** that exits 78, not a misconfigured one.

## The config that works

Verified end to end — `openclaw agent --local` returned `ok` with `stopReason=stop`:

```json
"models": {
  "providers": {
    "amazon-bedrock": {
      "api": "bedrock-converse-stream",
      "auth": "aws-sdk",
      "region": "us-east-1",
      "models": [
        { "id": "us.anthropic.claude-haiku-4-5-20251001-v1:0",
          "name": "Haiku",
          "api": "bedrock-converse-stream" }
      ]
    }
  }
}
```

## What clawops writes today, for comparison

```json
"models": { "provider": "bedrock", "modelId": "anthropic.claude-sonnet-4-6" }
```

Four defects in one object:

1. `models.provider` is not a key — the schema has `models.providers`. Rejected by validation as
   `unknown key "provider"`, **for every provider, not just Bedrock**
2. because the key is wrong, `requiredPlugins` reads `models.providers` and finds nothing, so the
   Bedrock plugin is never installed — which *is* startup-blocking (Finding 5)
3. no `api`, so the call routes through the wrong transport (Finding 1)
4. a bare foundation-model ID, which Bedrock rejects (Finding 2)

## Incidental

A memory subsystem still asks for an OpenAI API key at session startup even when no OpenAI
provider is configured:

```
[memory] sync failed (session-startup-catchup): No API key found for provider "openai"
```

It did not stop the run. Worth a look, not part of WO-64.

## Assertions to graduate

1. The wizard's model config validates against the captured schema, for every catalog provider. *(unit)*
2. A Bedrock plan emits a `models.providers.amazon-bedrock` block carrying `api: bedrock-converse-stream`. *(unit)*
3. Bedrock model IDs in `spec/models.yaml` are inference profiles, and the region prefix is derived
   from the deployment region rather than hardcoded. *(unit)*
4. A Bedrock config causes `requiredPlugins` to return the Bedrock plugin. *(unit)*
5. Instance-role credentials resolve from inside the container. *(VM, AWS-only — already SP-08's #4)*
