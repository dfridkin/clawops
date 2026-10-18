// Output trimming helper — per R14 (8KB cap).
// Full output is written to ~/.clawops/state/{stackName}.last-run.json for the resource.

import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { getConfigDir } from '../../config/store.js'

const MAX_BYTES = 8 * 1024

/**
 * Where a stack's last-run output is kept, or undefined for a name that is not a stack name.
 *
 * The name arrives from a resource URI, which any MCP client can write, and is joined into a
 * path. Pulumi stack names are letters, digits, `-`, `_` and `.`, so a name with a separator,
 * or one that starts with a dot, never names a stack and could name a file outside the state
 * directory.
 */
export function lastRunPath(stackName: string): string | undefined {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(stackName)) return undefined
  return path.join(getConfigDir(), 'state', `${stackName}.last-run.json`)
}

export function trimForMcp(
  output: string,
  stackName: string,
): { content: string; truncated: boolean } {
  // Always persist full output for the resource endpoint
  try {
    const file = lastRunPath(stackName)
    if (file) {
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ output }), 'utf-8')
    }
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
