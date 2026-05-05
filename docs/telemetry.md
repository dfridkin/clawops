# Telemetry & Privacy Policy

clawops is committed to user privacy. Here's what we collect (almost nothing), what we don't, and how to control it.

## TL;DR

- **clawops collects no telemetry by default.** Zero phone-home, zero analytics, zero crash reports.
- **OpenTelemetry export is opt-in** via `OTEL_EXPORTER_OTLP_ENDPOINT`. When enabled, traces and metrics go to YOUR endpoint, not ours.
- **Audit logs** are written to YOUR stderr (or a path you configure). They never leave your machine unless you ship them somewhere.
- **No update checks** that report version data. clawops checks for updates only when explicitly run with `clawops doctor` or via `npm`/your package manager.

## What clawops Does NOT Collect

clawops does not collect, transmit, or store any of the following without your explicit action:

- Your usage patterns (which commands you run, how often)
- Your cloud provider, region, or stack names
- Your version of clawops
- Your operating system or Node version
- Crash reports, errors, or stack traces
- Performance metrics or timing data
- Any kind of user identifier (anonymized or otherwise)

When you run `clawops up`, the only network traffic is:
- To your configured cloud provider (AWS, GCP, Azure)
- To your configured state backend (your S3/GCS/ADLS bucket)
- To your deployed instance (via SSH)

clawops itself never calls home.

## Optional Observability

For users who WANT structured observability for their own monitoring:

### OpenTelemetry

Set these environment variables to opt in:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=https://your-otel-collector.example.com:4318
export OTEL_SERVICE_NAME=clawops
export OTEL_EXPORTER_OTLP_HEADERS="api-key=your-api-key"
```

clawops will emit:
- Traces for each command and MCP tool invocation
- Metrics for command duration, error rates, plan apply duration
- Logs (via OTel logs API) if `OTEL_LOGS_ENABLED=1`

All data goes to YOUR collector. clawops has no default endpoint.

### Audit Log Forwarding

The audit log (`~/.clawops/mcp-audit.log` or stderr) is structured JSON. You can forward it anywhere you like:

```bash
clawops mcp serve 2>>/var/log/clawops-audit.log
```

Or pipe to your log shipping tool (Vector, Fluent Bit, etc.).

## What Gets Logged Locally

clawops writes structured logs to stderr by default (per ADR 0007). These contain:

- Operational events (command start/finish, errors)
- Provider/region/stack context
- Sanitized error details (per `spec/errors.yaml` redaction patterns)
- Audit entries for every MCP tool call (sanitized)

These never leave your machine unless you forward them.

### Sensitive Field Redaction

Pino's `redact` config and the audit logger's sanitization strip:

- `Authorization` headers
- Any field matching `*token*`, `*secret*`, `*password*`, `*key*` (with carve-outs for `keyName`/`keyPath` which are paths, not secrets)
- Provider-native credential env var values (`AWS_ACCESS_KEY_ID`, etc.)
- Connection strings

If you find a sensitive field that's not redacted, that's a bug — please report per `SECURITY.md`.

## Update Checks

clawops does NOT check for updates automatically. To check for a new version:

```bash
npm view clawops version       # latest published version
clawops version                 # installed version
```

Or run `clawops doctor` which includes a version check (still no telemetry; just compares your installed version to the npm registry).

## Cloud Provider Telemetry

Note that the cloud providers themselves (AWS CloudTrail, GCP Audit Logs, Azure Activity Log) record your API calls. clawops cannot prevent this; it's the provider's audit trail. Configure those services per your organization's policy.

## OpenClaw Telemetry

OpenClaw (the gateway software clawops deploys) may have its own telemetry. clawops does not modify OpenClaw's telemetry behavior. Refer to OpenClaw's own privacy policy.

## Skills Authoring

If a Claude Code skill in `.claude/skills/` (e.g., a contributor's custom skill) introduces telemetry, that's outside clawops's scope. Review skill source before invoking.

## Children's Privacy

clawops is not directed at children under 13. We collect no information at all, so this is moot, but called out for clarity.

## Changes to This Policy

Any change to telemetry behavior:

- Requires an ADR documenting the change
- Triggers a major version bump if it changes default behavior
- Is announced in the CHANGELOG and README before release

## Verification

You can verify clawops's telemetry posture by:

1. Reading the source: `grep -r "fetch\|http\|axios" src/` and reviewing every network call
2. Running clawops with strict outbound rules (e.g., a network-namespaced container) and observing it works for purely-local operations
3. Running with `OTEL_EXPORTER_OTLP_ENDPOINT` unset and checking no OTel traffic occurs
4. Reviewing the audit log of any clawops invocation

## Contact

Privacy concerns or questions: privacy@clawops.dev (or the maintainer; see README).
