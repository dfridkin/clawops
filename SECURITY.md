# Security Policy

## Reporting a Vulnerability

**Do not report security vulnerabilities through public GitHub issues.**

Instead, please report security issues via **<security@clawops.dev>** (or, until that's set up, by emailing the project maintainer directly — see the README for current contact).

You should receive a response within 72 hours. If for some reason you don't, please follow up to ensure your message was received.

Please include:

- Description of the issue
- Steps to reproduce
- Affected versions
- Potential impact
- Suggested fix (if any)

## Disclosure Process

1. **Acknowledgment** — within 72 hours of report
2. **Triage** — within 7 days; severity assigned (critical/high/medium/low)
3. **Fix development** — timeline depends on severity:
   - Critical: target 7 days
   - High: target 14 days
   - Medium: target 30 days
   - Low: next regular release
4. **Coordinated disclosure** — we'll work with you on a release date if you want public credit
5. **CVE assignment** — for critical/high severity issues affecting released versions

## Supported Versions

Only the latest minor version receives security patches. See `docs/support-matrix.md` for the current support window.

| Version | Supported |
|---|---|
| Latest minor (e.g., 1.x) | ✅ |
| Previous minor | Security only, 6 months |
| Older | ❌ |

## Threat Model

clawops's threat model is documented in `docs/security/threat-model.md`. Highlights:

### In Scope

- **Credential leakage**: clawops handles cloud credentials and gateway tokens. Leakage to logs, audit entries, MCP tool args, or the network is in scope.
- **MCP server abuse**: a compromised or malicious MCP client invoking destructive tools without user consent.
- **Plan tampering**: modification of a Maker plan between generation and apply.
- **State corruption**: corruption or unauthorized modification of Pulumi state files.
- **Supply chain**: compromise of clawops itself or its dependencies, leading to backdoored deployments.

### Out of Scope

- **Vulnerabilities in OpenClaw itself**: report to the OpenClaw project.
- **Cloud provider vulnerabilities**: report to AWS/GCP/Azure.
- **User's local machine compromise**: clawops cannot defend against an attacker with local shell access. We minimize blast radius (no plaintext credentials at rest, no long-lived tokens) but a compromised dev machine compromises the deployments.
- **DoS against your own cloud account**: we don't rate-limit clawops itself; you can run `clawops up` in a loop and exhaust your quota.

## Security Mitigations Built-In

clawops applies these by default per design rules R6, R10–R11, R18–R22, N9–N13:

- **Credentials** never stored in clawops config files (R6, N9)
- **Default-deny firewalls** (no `0.0.0.0/0` defaults) (N10)
- **Plan-then-apply** for all destructive operations (Maker pattern)
- **Filter-at-registration** for `--read-only` and `--no-destructive` modes (R18)
- **Elicitation confirmation** for destructive MCP tool calls (R19)
- **Token redaction** in audit logs and pino logger (R21, ADR 0007)
- **HTTP MCP binds 127.0.0.1** by default; non-loopback requires explicit flag (N12)
- **No token forwarding** — clawops's MCP server uses its own credentials, not the client's bearer token (R20)
- **Host key verification** on SSH (TOFU + recorded `known_hosts`)

## Security Reviews

We welcome external security review. If you're a researcher and want to evaluate clawops:

- Use a sandbox cloud account (we suggest a fresh project/account with budget alerts at $20)
- Do NOT test against production deployments without authorization
- Coordinate with us before publishing findings

## Bug Bounty

clawops does not currently run a bounty program. Researchers who report valid issues will be credited (if desired) in:

- The CHANGELOG entry for the fix
- The relevant ADR
- The README (for significant findings)

## Audit Trail

All security-relevant ADRs are tagged `security` in `docs/decisions/`. The threat model in `docs/security/threat-model.md` is reviewed annually or when major architectural changes happen.
