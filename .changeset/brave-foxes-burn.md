---
"@clawops/cli": minor
---

Add `clawops bug` command and fix 10 cloud deploy bugs found in audit

**New command: `clawops bug`**

`clawops bug` opens a pre-filled GitHub issue with system context (version, Node, OS, provider, stack count, SSH key presence) automatically populated. `--json` mode emits the URL without prompting or opening a browser, suitable for scripting.

`clawops doctor` now prints a `clawops bug` hint in its footer when it exits with an error.

**Cloud deploy bug fixes (AWS, GCP, Azure)**

- **Azure (deploy-blocking):** Fixed deprecated image reference `UbuntuServer/22.04-LTS` → `0001-com-ubuntu-server-jammy/22_04-lts-gen2`. Azure no longer publishes the old offer in most regions; every Azure deployment was broken.
- **AWS (silent failure):** Fixed Bedrock startup script using a plain `curl` to IMDS that always returned HTTP 401 because the EC2 instance requires IMDSv2 (`httpTokens: required`). The region env var always fell back to `us-east-1` regardless of actual region. Now uses the two-step PUT→GET token flow.
- **Azure (feature-broken):** Fixed `roleDefinitionId` in Key Vault role assignment missing the `/subscriptions/{id}/` prefix — the ARM API rejected the short form. Key Vault RBAC (`keyVaultEnabled=true`) was entirely non-functional.
- **All providers (silent lockout):** `accessMode=auto` egress IP detection now returns a `Result` type. If detection fails (network error, timeout, non-200 response), the program throws a clear error instead of silently producing a VM with zero ingress rules and no way to connect.
- **AWS (day-2 ops, ⚠️ migration impact):** Migrated from inline `SecurityGroup` ingress/egress arrays to individual `SecurityGroupIngressRule`/`SecurityGroupEgressRule` resources. This prevents Pulumi from replacing the entire Security Group (and causing a connectivity outage) when CIDRs change. **Existing AWS stacks will have their Security Group replaced on the first `clawops up` after this upgrade** — see `docs/decisions/0009-aws-sg-rule-resources.md` for the import-based mitigation path.
- **AWS (security):** Replaced `AmazonBedrockFullAccess` with a least-privilege inline policy granting only `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream`.
- **All providers (correctness):** Extracted shared `src/providers/startup.ts`. Fixes: missing `chown clawops:clawops /home/clawops/.ssh` in GCP script, missing `docker-buildx-plugin` and `docker-compose-plugin` in all three providers, GPG key download updated to direct `.asc` method (no `gpg --dearmor` pipe).
- **GCP:** Switched `detectEgressIp` from `checkip.amazonaws.com` (AWS-operated) to `ifconfig.me` (provider-neutral).
- **GCP:** Added missing `?? ''` / `?? 22` / `?? 'clawops'` fallbacks to `getConnectionInfo` (parity with AWS/Azure adapters).
- **SSH:** `tunnel()` server error handler now calls `closeAll()` before rejecting, preventing accepted sockets from leaking.

**v1.6 internal work**

- `src/config/profiles.ts` — credential resolution from `credentialsRef` (was a stub)
- `src/config/secrets.ts` — `$secret:<NAME>` reference resolver for config overlays (was a stub)
- `src/pulumi/components/` — proper `ComponentResource` classes for Gateway, Network, Secrets, Server (were stubs)
- Local VM e2e test harness (`tests/e2e/local/`) using testcontainers + real SSH
