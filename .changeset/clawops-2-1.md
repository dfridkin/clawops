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

---

**Documentation corrections found while writing the cloud end-to-end plan.**

`docs/providers/gcp.md` listed `CLOUDSDK_AUTH_ACCESS_TOKEN` as a supported credential source.
The adapter reads `GOOGLE_OAUTH_ACCESS_TOKEN`; the other is gcloud-internal. It also still said
the GCP firewall opens both ports to `0.0.0.0/0` with per-CIDR "on the roadmap" — per-CIDR
landed in 2.0, and since 2.0 no gateway rule is created at all under loopback publishing.

The smoke-test plan was 1.x-era throughout. It now leads with what 2.0 changed and the
assertions that follow from it, and `pnpm test:cloud gcp|azure` runs them against a real
deployment and destroys it afterwards — including when an assertion fails.

---

**`clawops setup` checks your cloud account is ready, and offers to fix what it can.**

A GCP project with working credentials and the Compute API disabled passes every check clawops
used to make, and then fails partway through a deploy:

```
Compute Engine API has not been used in project <id> before or it is disabled
```

The wizard now checks before provisioning anything — required APIs enabled, the state bucket
present, the project resolvable — and **asks** before changing anything, naming the exact
mutation:

```
? Fix this now? Enables compute.googleapis.com on project my-project (Y/n)
```

`clawops doctor` reports the same checks without offering to change anything.

Neither is infrastructure, which is why neither lives in the Pulumi program: the state bucket
has to exist before Pulumi can run at all, so a deploy cannot create it on its way past. When
clawops creates one it enables versioning — Pulumi state with no history is a stack that can
no longer be updated or destroyed.

---

**`clawops doctor` never validated cloud credentials.**

`registerProvider` existed and was called by nothing, so `getProvider` threw for every
provider. Doctor's Credentials section reported this for any cloud stack:

```
✗ gcp  stack "prod" — No provider adapter registered for 'gcp'. Run `clawops init`…
```

Deploys were unaffected — `up`, `plan` and `apply` resolve the adapter directly — so the only
symptom was a diagnostic that said something alarming and untrue. Adapters register on import
now, and doctor validates credentials as it always claimed to.

---

**Every cloud stack was deployed with no ingress rules at all.**

`clawops apply` validated the plan's `network.allowedSshCidrs`, printed them in the plan
summary, and then never passed them to Pulumi. The programs read them from stack config, so
they resolved empty:

```
resolveIngressCidrs('restricted', '', '', …) → []
```

Not a narrower rule — **none**. clawops creates its own VPC, so nothing else opened SSH, and a
freshly deployed instance was unreachable by `ssh`, `logs`, `tunnel`, `harden` and every other
day-two command. The plan said who could connect and apply ignored it.

Fixed, with the deny-all default (`accessMode: restricted`) passed explicitly alongside.
