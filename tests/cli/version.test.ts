// The CLI reported a hardcoded '0.2.0' in `--help` and `--version` while the package
// was on 1.7.3 — five releases stale — because the citty meta carried a literal rather
// than the build-time define that `clawops bug` already used.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '../..')

describe('CLI version', () => {
  it('is not hardcoded in the citty meta', () => {
    const src = readFileSync(join(ROOT, 'src/cli/index.ts'), 'utf-8')
    // A literal version here silently drifts from package.json on every release.
    expect(src).not.toMatch(/version:\s*['"]\d+\.\d+\.\d+['"]/)
    expect(src).toContain('__CLI_VERSION__')
  })

  it('is sourced from the same define the bug reporter uses', () => {
    // Two version sources that disagree is how the drift went unnoticed: `clawops bug`
    // filed issues with the real version while `--version` reported the stale one.
    const cli = readFileSync(join(ROOT, 'src/cli/index.ts'), 'utf-8')
    const bug = readFileSync(join(ROOT, 'src/cli/commands/bug.ts'), 'utf-8')
    expect(cli).toContain('__CLI_VERSION__')
    expect(bug).toContain('__CLI_VERSION__')
  })

  it('is injected by the build', () => {
    const tsup = readFileSync(join(ROOT, 'tsup.config.ts'), 'utf-8')
    expect(tsup).toContain('__CLI_VERSION__')
  })
})
