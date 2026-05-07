// Output trimming helper — per R14 (8KB cap).
// Full output is written to ~/.clawops/state/{stackName}.last-run.json for the resource.

import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { getConfigDir } from '../../config/store.js'

const MAX_BYTES = 8 * 1024

export function trimForMcp(
  output: string,
  stackName: string,
): { content: string; truncated: boolean } {
  // Always persist full output for the resource endpoint
  try {
    const dir = path.join(getConfigDir(), 'state')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, `${stackName}.last-run.json`), JSON.stringify({ output }), 'utf-8')
  } catch {
    // Non-fatal
  }

  if (Buffer.byteLength(output) <= MAX_BYTES) {
    return { content: output, truncated: false }
  }

  const trimmed = output.slice(0, MAX_BYTES)
  return {
    content:
      trimmed +
      `\n\n[Output truncated at 8KB. Full output available at clawops://stacks/${stackName}/last-run]`,
    truncated: true,
  }
}
