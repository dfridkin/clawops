import { defineCommand } from 'citty'
import process from 'node:process'
import { success, failure, warn, info, REPO_URL } from '../../output/human.js'
import { printJson, jsonOk } from '../../output/json.js'
import { runDiagnostics, type DiagnosticsReport, type Check } from '../../diagnostics/index.js'

// The checks themselves live in src/diagnostics — they are also what clawops_doctor
// returns over MCP, where writing to stdout is forbidden (R15). This file renders.
const NAME_COLUMN = 13

export default defineCommand({
  meta: {
    name: 'doctor',
    description: 'Check system prerequisites, config, SSH keys, and cloud credentials',
  },
  args: {
    stack: { type: 'string', description: 'Stack name to include remote health checks' },
    json: { type: 'boolean', description: 'Emit the report as JSON' },
  },
  async run({ args }) {
    const ac = new AbortController()
    const abort = () => ac.abort()
    process.on('SIGINT', abort)
    process.on('SIGTERM', abort)

    let report: DiagnosticsReport
    try {
      report = await runDiagnostics({ stack: args.stack, signal: ac.signal })
    } finally {
      process.off('SIGINT', abort)
      process.off('SIGTERM', abort)
    }

    if (args.json) {
      printJson(jsonOk(report))
    } else {
      render(report)
    }

    // Exit non-zero when a check failed, not only when Node is too old. `doctor` is what
    // a script or a CI step runs to decide whether a deployment is healthy; an unreadable
    // SSH key or an unsupported gateway used to exit 0 and read as success.
    if (!report.ok) {
      if (!args.json) {
        process.stdout.write(
          `Run \`clawops bug\` to open a pre-filled issue at ${REPO_URL}/issues\n\n`,
        )
      }
      process.exit(1)
    }
  },
})

function render(report: DiagnosticsReport): void {
  process.stdout.write('\nclawops doctor\n')
  for (const section of report.sections) {
    process.stdout.write(`\n${section.title}\n`)
    for (const check of section.checks) line(check)
  }
  process.stdout.write('\n')
}

function line(check: Check): void {
  const label = check.detail ? `${check.name.padEnd(NAME_COLUMN)}${check.detail}` : check.name
  const emit = { pass: success, fail: failure, warn, info }[check.status]
  emit(label)
  if (check.remedy) info(`  ${check.remedy}`)
}
