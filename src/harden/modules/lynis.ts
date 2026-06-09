// Lynis CIS Level 1 report module (opt-in, read-only).
// Runs lynis audit system and saves a scored report; does not auto-remediate.

import path from 'node:path'
import os from 'node:os'
import { mkdirSync, writeFileSync } from 'node:fs'
import type { HardeningModule, RemoteExec, CheckResult, ApplyResult } from '../types.js'
import { SENTINEL_DIR } from '../types.js'

const SENTINEL = `${SENTINEL_DIR}/lynis.applied`

export const lynisModule: HardeningModule = {
  id: 'lynis',
  label: 'CIS Level 1 report (lynis)',
  defaultOn: false,
  providers: 'all',

  async check(exec: RemoteExec): Promise<CheckResult> {
    const { stdout: installed } = await exec(`which lynis 2>/dev/null || echo ''`)
    if (!installed.trim()) {
      return { status: 'missing', detail: 'lynis not installed (will install on apply)' }
    }
    const { stdout: sentinel } = await exec(`test -f ${SENTINEL} && echo yes || echo no`)
    if (sentinel.trim() === 'yes') {
      return { status: 'applied', detail: 'lynis audit has been run (sentinel present)' }
    }
    return { status: 'missing', detail: 'lynis installed but audit not yet run' }
  },

  async apply(exec: RemoteExec, stackName?: string): Promise<ApplyResult> {
    const script = [
      `mkdir -p ${SENTINEL_DIR}`,
      'apt-get install -y -q lynis',
      // Run non-interactively; pipe stdout + stderr to a tmp file
      'lynis audit system --no-colors --quick 2>&1 | tee /tmp/lynis-report.txt || true',
      `touch ${SENTINEL}`,
    ].join(' && ')

    const { code, stderr } = await exec(`sudo sh -c '${script.replace(/'/g, "'\\''")}'`)
    if (code !== 0) {
      throw new Error(`lynis run failed (exit ${code}): ${stderr.slice(0, 200)}`)
    }

    // Fetch the report output
    const { stdout: report } = await exec('cat /tmp/lynis-report.txt 2>/dev/null || echo ""')

    // Parse score and top findings
    const scoreMatch = report.match(/Hardening index\s*:\s*(\d+)/i)
    const score = scoreMatch ? scoreMatch[1] : 'unknown'

    const suggestions = report
      .split('\n')
      .filter((l) => l.includes('Suggestion') || l.includes('[suggestion]'))
      .slice(0, 5)
      .map((l) => l.trim())

    // Save full report locally
    const reportsDir = path.join(os.homedir(), '.clawops', 'reports')
    mkdirSync(reportsDir, { recursive: true })
    const date = new Date().toISOString().slice(0, 10)
    const name = stackName ?? 'stack'
    const reportPath = path.join(reportsDir, `${name}-lynis-${date}.txt`)
    writeFileSync(reportPath, report, 'utf-8')

    const detail = `Hardening index: ${score}/100. Full report: ${reportPath}` +
      (suggestions.length ? `\nTop suggestions:\n  ${suggestions.join('\n  ')}` : '')

    return { changed: true, detail }
  },
}
