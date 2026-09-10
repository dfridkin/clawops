// clawops_doctor handler
//
// The checks live in src/diagnostics because the CLI command used to own them and print
// them as it went — unusable here, since a stdio MCP server writing to stdout breaks the
// protocol (R15). This handler runs the same report the CLI renders and serialises it.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { DoctorInput } from '../_generated.js'
import { okText } from '../_conn.js'
import { trimForMcp } from '../_trim.js'
import { runDiagnostics, type DiagnosticsReport } from '../../../diagnostics/index.js'

export async function handleDoctor(input: DoctorInput, _server: McpServer): Promise<CallToolResult> {
  const ac = new AbortController()
  const report = await runDiagnostics({ stack: input.stackName, signal: ac.signal })
  const payload = input.failuresOnly ? failuresOnly(report) : report

  // R14. A full report with hardening drift across a dozen modules runs long, and the
  // part an agent needs — what failed — is what survives the trim either way, because
  // sections keep their order and failures are what the caller asked for.
  const { content } = trimForMcp(JSON.stringify(payload, null, 2), input.stackName ?? 'local')
  return okText(content)
}

/**
 * Drop passing checks, keep the counts.
 *
 * Reporting `ok` and the counts from the full report rather than recomputing them: a
 * filtered view that recalculated `ok` from what it kept would say `ok: false` for a
 * report whose only non-passing checks were warnings.
 */
function failuresOnly(report: DiagnosticsReport): DiagnosticsReport {
  const sections = report.sections
    .map((s) => ({ ...s, checks: s.checks.filter((c) => c.status === 'fail' || c.status === 'warn') }))
    .filter((s) => s.checks.length > 0)
  return { sections, ok: report.ok, counts: report.counts }
}
