# Support Matrix

This document consolidates support information from CLAUDE.md, SPEC.md, and `spec/openclaw-versions.yaml`. It's the single page to point users at when they ask "does clawops work with X?"

## Node.js

| Version | Support |
|---|---|
| 22.x | ✅ Tested in CI on every PR |
| 20.x | ✅ Tested in CI on every PR (minimum) |
| 18.x | ❌ Not supported (Node 18 EOL April 2025) |
| 24.x | ⚠️ Best-effort; not in CI matrix yet |

Reasoning for Node 20 minimum: stable Web Crypto API (used by MCP auth flows), structured cloning, and the Pulumi Automation API's compatibility floor.

## Operating Systems

| OS | Support |
|---|---|
| macOS 13+ (Ventura) | ✅ Primary development target |
| macOS 14, 15 | ✅ |
| Ubuntu 22.04 | ✅ Tested in CI |
| Ubuntu 24.04 | ✅ |
| Debian 12 | ✅ Smoke-tested |
| RHEL 9 / Rocky 9 / Alma 9 | ✅ Smoke-tested |
| Fedora 40+ | ⚠️ Best-effort |
| Windows (WSL2) | ✅ |
| Windows (native) | ❌ Not supported in v1; v1.1+ stretch goal |

The MCP server in stdio mode requires a POSIX-like environment for the working-directory invariants (R7, R17). Native Windows would need its own ADR.

## Cloud Providers

| Provider | Status | Tested Regions |
|---|---|---|
| AWS | ✅ v1 | us-east-1, us-west-2, eu-west-1 |
| GCP | ✅ v1 | us-central1, europe-west1 |
| Azure | ✅ v1 | eastus, westeurope |
| Local VM (SSH) | ✅ v1 | (any reachable Ubuntu/Debian/RHEL host) |
| Hetzner Cloud | ⏳ v1.1 candidate |
| DigitalOcean | ⏳ v1.1 candidate |
| Oracle Cloud | ⏳ v1.1 candidate |
| Cloudflare (Workers/Pages) | ❌ Not planned |

## OpenClaw Versions

`spec/openclaw-versions.yaml` is the canonical machine-readable matrix, and since v1.7.2 it is
**enforced** — `doctor`, `plan`, `up` and `apply` refuse a version outside the supported range
rather than deploying something that cannot work.

| OpenClaw Version | Support |
|---|---|
| 2026.7.1-2 | ✅ Recommended |
| 2026.4.5 – 2026.7.1-2 | ✅ Supported |
| < 2026.4.5 | ❌ Different config schemas and channel registration semantics |
| **>= 2026.8.1** | ❌ **Not supported on the clawops 1.x line** — use clawops 2.x |

### OpenClaw 2.0 (2026.8.1 and later)

OpenClaw 2.0 changed the container runtime contract. Verified against `2026.8.1`:

- Sessions, transcripts and credentials moved into SQLite under a state directory the 1.x line does
  not mount, so every container replacement discards them.
- Config moved to a writable path; the file this line mounts is read by nothing.
- Model providers became install-gated plugins — a configured but uninstalled provider prevents the
  gateway from starting at all.

Deploying it from this line produces a crash-looping gateway (exit 78). clawops refuses it instead.

`clawops doctor --stack <name>` reports the version a deployed gateway is actually running, so a
stack that picked up 2.0 through a moving tag can be identified.

**Moving tags are not accepted unresolved.** `latest` and `stable` both point at OpenClaw 2.0.
clawops resolves a moving tag to a concrete release before checking it, and refuses one it cannot
resolve rather than assuming compatibility. The default is a concrete pin.

### Bedrock

The 2.0-era form is `auth.profiles.<id>.mode: "aws-sdk"` in `openclaw.json`, and the Bedrock
provider is a separately installed plugin requiring OpenClaw >= 2026.9.1. The older guidance —
`AWS_PROFILE` in the systemd EnvironmentFile, with `auth: "aws-sdk"` ignored — applied to the
2026.4.x line and no longer describes current behaviour.


## MCP Clients

| Client | Tested |
|---|---|
| Claude Desktop (macOS, Windows, Linux) | ✅ |
| Claude Code | ✅ |
| Cursor | ✅ |
| VS Code (Copilot Chat) | ✅ |
| Windsurf | ✅ |
| Zed | ✅ |
| Continue.dev | ⚠️ Should work; not formally tested |
| Custom MCP clients | ✅ Anything supporting stdio or Streamable HTTP transport |

## Pulumi

| Component | Version |
|---|---|
| `@pulumi/pulumi` (Automation API) | 3.x |
| `@pulumi/aws` | 6.x |
| `@pulumi/gcp` | 7.x |
| `@pulumi/azure-native` | 2.x |

User does NOT need Pulumi CLI installed (ADR 0006). The engine is embedded.

## Package Manager

| Tool | Status |
|---|---|
| pnpm 9.x | ✅ Recommended (used by maintainers) |
| pnpm 10.x | ⚠️ Should work; verify hoisting config (ADR 0003) |
| npm 10.x | ✅ Works |
| yarn 4.x | ⚠️ Should work; not regularly tested |
| bun | ❌ Not supported |

## Architecture

| Arch | Status |
|---|---|
| x86_64 (amd64) | ✅ Primary |
| arm64 (Apple Silicon, AWS Graviton) | ✅ |
| 32-bit | ❌ Not supported |

## Deployment Target Architectures

clawops can deploy OpenClaw to:

- x86_64 instances (default)
- arm64 instances (provider-dependent — AWS Graviton, GCP T2A, Azure Ampere)

## Support Lifecycle

| clawops version | Type of support | Duration |
|---|---|---|
| Latest minor (e.g., 1.7.x) | Full support | Until next minor release |
| Previous minor (e.g., 1.6.x) | Security only | 6 months after 1.7.0 |
| Older | None | Upgrade required |

Major version bumps follow [SemVer](https://semver.org/) and document migration paths in the corresponding ADR.

## How to Request Support

1. **Bugs / unexpected behavior**: GitHub issue, use the bug report template
2. **Security**: SECURITY.md (private channel)
3. **Feature requests**: GitHub issue, feature request template
4. **Provider requests**: GitHub issue, provider request template (specify cloud, regions you need, OS images, IAM model)
5. **Discussion / questions**: GitHub Discussions

## Compatibility Testing Strategy

The CI matrix exercises:

- Node 20.x and 22.x
- Ubuntu latest
- macOS latest (limited; for build verification only)
- pnpm 9.x

E2E tests against real cloud accounts run on a separate cadence (manually triggered) to control cost.

## Versioning Policy

- **Major** (X.0.0): breaking changes; ADR required; migration guide required
- **Minor** (1.X.0): new providers, new MCP tools, new flags with safe defaults
- **Patch** (1.0.X): bug fixes, performance, security patches, doc fixes

We commit to:
- No breaking changes within a major
- Deprecation warnings ≥ 6 months before removal
- CHANGELOG entries for every release (via changesets)
