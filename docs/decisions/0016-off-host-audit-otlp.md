# ADR 0016, Audit records leave the host over OTLP

**Status:** Proposed
**Date:** 2026-11-17
**Deciders:** Project owner
**Revisit:** if an operator needs a guarantee the receiving end enforces (object lock, WORM), or if
OTLP/HTTP JSON stops being accepted by the common collectors

## Context

Every clawops audit record is written by one function, `auditLog` in `src/mcp/audit.ts`, to an
NDJSON file on the machine clawops runs on: `~/.clawops/mcp-audit.log` for the operator's
clawops, and the host agent's state directory on a gateway host. That covers MCP tool calls,
peer-listener answers and refusals (ADR 0015 §7), and the fleet firewall-table repairs.

A file on the host is not a record of what happened on that host. WO-62's precondition 5, "audit
shipped off-host", exists because an injected agent with `backup_restore` can roll back its own
trail, and the [threat model](../security/threat-model.md) (T11) repeats it. 2.4 meets it without
shipping anything: every change runs on the operator's machine (ADR 0014 §5), so the record of
every change is written there, off the gateway host. The [roadmap](../roadmap.md) says it reopens
once a peer's task runs on a host, and makes it P3, in 2.6, ahead of that: a sandboxed task (P4)
or a peer handoff (P7) that can erase its own trail cannot be reviewed. The host agent's own
records (what it read, what peers asked it, every refusal) are on the gateway host already.

P3's bar: clawops, host-agent and peer audit records export to an endpoint the operator owns,
through a credential on the host that can **append but not delete or rewrite**.

P3 also carries WO-56: making the gateway's observability configurable. OpenClaw already has it.
The 2.0 config schema (`spec/openclaw-2.0.config.schema.json`) has `diagnostics.otel`:
`endpoint`, per-signal `tracesEndpoint`, `metricsEndpoint` and `logsEndpoint`, `headers`,
`serviceName`, `traces`, `metrics` and `logs` toggles, `sampleRate`, `flushIntervalMs`, and
`captureContent` (off by default). Its `protocol` accepts only `http/protobuf`.

The decision of 2026-11-16: the sink is **an OTLP endpoint**, not an immutable object store.

## Decision

### 1. One sink: OTLP/HTTP logs, to a collector the operator runs or rents

Each audit record is also sent as one OTLP log record to `<endpoint>/v1/logs`. Both the gateway
(WO-56) and clawops then report to the same collector, so a single endpoint and a single
retention policy cover both.

- **Encoding: OTLP/HTTP with JSON bodies** (`application/json`). Every OTLP/HTTP receiver accepts
  it (the OpenTelemetry Collector's `otlphttp`, Grafana Alloy, and the vendors' native intakes),
  and it needs no protobuf dependency in a CLI that must stay small. The gateway's own export is
  `http/protobuf`, which the same receivers also accept.
- **Mapping:** the record's fields become log attributes under `clawops.audit.*`. `body` is the
  tool name, `severityText` is `INFO` for `ok` and `WARN` for `error`, and `timeUnixNano` comes
  from `ts`. The resource carries `service.name=clawops`, plus `clawops.stack` and
  `clawops.role` (`operator` or `host-agent`). Redaction runs before the record is written, so
  nothing leaves the host that the local file would not hold ([redaction](../security/redaction.md)).

### 2. Append-only is a property of the credential, and the operator chooses it

OTLP has no read, delete or update call. A push to `/v1/logs` can only add records, so a
credential that authenticates only that push can only append. The ingestion keys the common
backends issue are of that kind: write-scoped tokens that cannot query or delete.

clawops cannot see a token's scope. So the docs name the scope to ask for, per backend, and
`clawops doctor` says plainly that it checked reachability and not scope. Records that already
left the host stay where they are: deleting them needs a different credential, which is not on
the host.

### 3. Tamper-evident, not just shipped

Every record gains `seq`, a per-log counter, and `prev`, the SHA-256 of the previous record's
line. A collector-side query can then show what shipping alone cannot: a gap in `seq`, or a
`prev` that does not match, is a record that was removed or rewritten on the host before it
was sent. The local file carries the same fields, so it can be checked too.

### 4. The local file stays the primary record, and export never blocks a tool call

`auditLog` keeps writing the file synchronously, first. Export is asynchronous and reads that
file from a saved byte offset: one batch per second at most, retried with backoff, at least
once. Records carry `seq`, so a receiver can drop duplicates. The file doubles as the spool, so
a collector outage or a restart loses nothing that is still on disk.

What this does not cover, stated in [limitations](../limitations.md): a record written in the
window after a compromise starts and before its batch leaves can still be rewritten. The window
is the batch interval plus any outage. `seq` and `prev` still show the gap afterwards.

An export failure is never a tool failure. The exporter writes one `audit_export` record per
distinct failure reason, the same rule the fleet table repair follows, and `clawops doctor` gains
an **Audit export** check. It reports the endpoint, the last successful push, and the backlog in
records, and it warns when the backlog is older than five minutes.

### 5. Where the endpoint and the credential live (R6)

- **The endpoint** is configuration: `audit.export.endpoint` in `~/.clawops/config.json`, and in
  the host agent's `agent.json`.
- **The credential** is never in either file. On the operator's machine it comes from
  `CLAWOPS_AUDIT_OTLP_HEADERS`, in the same `key=value,…` form as `OTEL_EXPORTER_OTLP_HEADERS`.
  On a gateway host it sits in the host agent's root-only `EnvironmentFile` (`agent.env`), next
  to its MCP token, and the gateway's agent cannot read it (ADR 0014).
- **No MCP tool sets, changes or disables either.** An agent that could repoint the export could
  send the trail somewhere else, or nowhere. This follows spending limits (2.3): they live in
  config, the operator sets them, and no tool can lift them. `clawops agent install` takes
  `--audit-endpoint`, and the command is already `NO_TOOL` by design (ADR 0014). The reason is
  added to `NO_TOOL`'s note and to [limitations](../limitations.md). `clawops_doctor`
  reports the export's state, read-only.

### 6. WO-56: the gateway's own OTel, through the plan

The deploy plan gains an optional `observability` block. It sets the gateway's
`diagnostics.otel` keys from the schema above and nothing else, so P5's config surface is not
pre-empted. Two rules:

- **`captureContent` stays off** unless the plan sets it, and the plan's review shows that it does.
  It exports message and tool content, which is the disclosure the host agent's review
  ([host-agent disclosure review](../security/host-agent-disclosure-review.md)) exists to
  prevent.
- **Headers are environment references**, such as `${OTEL_INGEST_TOKEN}`, resolved from the
  gateway's env file. The literal value goes through `clawops secret set`, never through the plan.

`config set diagnostics.otel.*` keeps working as it does now. The plan block is how a deployment
records the setting so it survives a redeploy.

### 7. Spike first: SP-17

Measured on the pinned OpenClaw before any WO-56 code, because the spec and work orders have
been wrong about OpenClaw before and only measurement caught it. On the 2026.9.2 image, in local Docker, with an OpenTelemetry Collector container as the
receiver:

1. Does `diagnostics.otel.enabled: true` need a plugin that is not bundled? SP-10 found that a
   missing provider plugin is installed from ClawHub when egress allows it, and that the gateway
   starts silently without it when egress is denied. If that is true here, a hardened host loses
   its telemetry without any error, and `doctor` must check for it.
2. Which signals arrive, under which `service.name`, and what a log record contains with
   `captureContent` off.
3. Whether the `headers` values resolve `${ENV}` references.
4. That clawops' OTLP/HTTP JSON records are accepted by the same collector, next to the
   gateway's protobuf ones.

## Consequences

**Positive:**
- Off-host audit works the same on every provider, local included, with no cloud integration
  for each one.
- One collector receives clawops' audit and the gateway's telemetry, so there is one retention
  policy to set.
- `seq` and `prev` make a removal visible even in the window the export cannot close.

**Negative:**
- How long records are kept, and whether they can be deleted later, is the receiving backend's
  and the operator's business. clawops can say which scope to ask for, but cannot enforce it.
- There is a window between a write and its push. It is bounded and detectable, not closed.
- A second write path, with a spool cursor to keep correct across log rotation (WO-35 rotates the
  host agent's log).

**Neutral:**
- No new MCP tools. The catalog stays at the R1 cap of 30.

## Alternatives Considered

### Alternative A: immutable object storage (S3 Object Lock, GCS retention lock, Azure immutable blob)
- Pro: the storage itself refuses deletes, which is a stronger guarantee than a token's scope.
- Con: three cloud integrations, each with its own role, plus a separate answer for local
  stacks. Writing records one at a time to object storage means many small objects; batching
  them widens the window this ADR is trying to keep short.
- Why not chosen: the operator chose OTLP on 2026-11-16. An object-store exporter can still be
  added later behind the same cursor and spool, with records in the same shape.

### Alternative B: syslog (RFC 5424 over TLS)
- Pro: universal, and append-only by nature.
- Con: one more transport next to the gateway's OTLP, so two endpoints to run; structured fields
  get flattened; and TLS client authentication is how syslog authenticates, which is awkward to
  provision per host.
- Why not chosen: OTLP carries the same records, structured, to the endpoint the gateway already
  speaks.

### Alternative C: OTLP via the OpenTelemetry JS SDK
- Pro: the standard exporter, with batching and retries built in.
- Con: a large dependency tree in a CLI that runs through `npx`. Its batching is in memory, so a
  restart loses whatever is still in the queue; reading the file from a cursor does not.
- Why not chosen: the protocol is a single POST of JSON, and the durability has to come from the
  file anyway.

## Verification

- Unit: the record-to-OTLP mapping, with redaction already applied; `seq` and `prev` across a
  restart and across log rotation; the cursor never skips a record (mutation-checked); and an
  export failure leaves the tool's result untouched.
- Unit: `tests/mcp/parity.test.ts` documents the endpoint as something no tool reaches, and the
  catalog stays at 30.
- e2e (systemd target): a collector container receives every record of an MCP session in order.
  The suite then stops the collector, runs calls, restarts it, and checks the backlog arrives
  with no gap in `seq`. It also rewrites a line of the local file and checks the `prev`
  mismatch shows at the collector.
- e2e (fleet): peer answers and refusals arrive from both host agents, with the caller fields.
- SP-17's assertions land as tests in the WO-56 PR.

## References

- [ADR 0014](0014-host-agent-operator-handoff.md): the operator runs every change; the host agent
  is operator-only
- [ADR 0015](0015-host-agent-fleet.md) §7: peer audit fields
- [Audit logs](../security/audit-logs.md), [redaction](../security/redaction.md),
  [telemetry](../telemetry.md), [logging](../logging.md)
- WO-62 precondition 5 in [the 2.0 migration plan](../openclaw-2.0-migration-plan.md)
- OTLP specification, OTLP/HTTP: https://opentelemetry.io/docs/specs/otlp/#otlphttp
