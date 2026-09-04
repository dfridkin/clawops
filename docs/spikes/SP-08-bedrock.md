# SP-08 — Bedrock via EC2 instance role

**Status:** COMPLETE — 2026-09-04. Real EC2 (`i-0c49a058f8fc906b5`), instance profile
`clawops-spike-bedrock` with `AmazonBedrockFullAccess`, no credentials anywhere on the box.

**Verdict: Bedrock works — but not on 2026.8.1. This moves the version floor.**

## What was already right

`src/providers/aws/program.ts:208-211` already sets `metadataOptions.httpTokens: 'required'` with
`HttpPutResponseHopLimit: 2` and the comment *"so Docker containers on this host can reach IMDS"*.
Verified: IMDSv2 resolves from **both** the host and inside a bridge-networked container.

```
host      → role: clawops-spike-bedrock, region: us-east-1
container → token ok, role resolved, credentials {"Code":"Success", …}
```

No gap. This is a case where the existing implementation anticipated the problem correctly.

## Finding 1 — Bedrock is not bundled; it is a ClawHub plugin

Stock providers in the 2.0 image are **anthropic** and **openai** only. Bedrock ships as
`clawhub:@openclaw/amazon-bedrock-provider` (official, v2026.9.1) and must be installed.

## Finding 2 — configuring Bedrock without the plugin blocks startup

```
Plugin "amazon-bedrock" requires capability consent…
OpenClaw plugin verification failed; refusing to report the gateway ready.
gateway: exited exit=1
```

This is not a degraded provider — **the gateway refuses to start**. clawops's AWS adapter treats
Bedrock as first-class (it attaches `AmazonBedrockFullAccess` automatically), so on 2.0 that path
produces a dead gateway. G8 was scoped as "the quirk changed shape"; it is actually startup-blocking.

## Finding 3 — the plugin will not install on 2026.8.1

```
Plugin "@openclaw/amazon-bedrock-provider" requires plugin API >=2026.9.1,
but this OpenClaw runtime exposes 2026.8.1.
```

**Bedrock cannot be used on 2026.8.1 at all.** Not a configuration problem — a hard runtime gate.

## Finding 4 — it all works on 2026.9.1

```
Installed plugin: amazon-bedrock
gateway: running   /startupz: {"ok":true,"status":"started"}
```

With `auth.profiles."bedrock:default" = { provider: "amazon-bedrock", mode: "aws-sdk" }`, no API key,
no `AWS_PROFILE`, credentials from the instance role alone. `models status` reports
*"Providers w/ OAuth/tokens (0)"* — correct: external auth routes are not stored credentials, exactly
as upstream documents.

**The 2.0-era Bedrock shape is confirmed:** `auth.profiles.<id>.mode: "aws-sdk"` in `openclaw.json`.
The old `auth: "aws-sdk"` marker inside the provider block, and the `AWS_PROFILE`-in-EnvironmentFile
quirk recorded in `CLAUDE.md`, are both obsolete.

## Consequence — move the floor to 2026.9.1

The plan sets `support.min: "2026.8.1"`. That is not supportable: a headline clawops feature cannot
work there, and the failure is a gateway that will not start.

| | |
|---|---|
| Old | `support.min: "2026.8.1"` |
| **New** | **`support.min: "2026.9.1"`** |

Affects WO-37 (version spec), WO-51 (enforcement), WO-50 (`1.x` ceiling stays `2026.7.1-2`), and every
doc quoting the range. It also strengthens the §9 recommendation for a CI test asserting the range
agrees across all four places it is written.

## New requirements for WO-43 / bootstrap

1. **Install provider plugins during bootstrap**, before first gateway start, with
   `--accept-capabilities`. A configured-but-uninstalled provider is a startup failure, not a warning.
2. **New egress dependency: ClawHub.** Plugin installation fetches from the registry and links
   `peerDependency "openclaw" -> /app`. This belongs in `/audit-egress` and the firewall notes.
3. **Plugin/runtime version skew is real.** The plugin advertised v2026.9.1 against a v2026.8.1
   runtime and refused. `spec/models.yaml` must record a minimum runtime per provider plugin, not
   just a package name.

## Assertions to graduate

1. A plan selecting Bedrock emits a bootstrap step installing `@openclaw/amazon-bedrock-provider`. *(unit)*
2. Bedrock config uses `auth.profiles.<id>.mode`, never the legacy provider-block marker. *(unit)*
3. Version enforcement refuses `< 2026.9.1`. *(unit)*
4. Instance-role credentials resolve from inside the container. *(VM, AWS-only)*
