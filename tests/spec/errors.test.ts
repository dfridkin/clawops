// spec/errors.yaml is ground truth (R-meta-1), and nothing is generated from it. Its header used
// to say `pnpm gen:schemas` emitted the error classes and CI checked them, neither of which was
// true (#185), so the spec and the code could drift with nothing to notice. This notices.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { load } from 'js-yaml'
import * as errors from '../../src/errors/index.js'
import { SENSITIVE_KEYS } from '../../src/mcp/audit.js'

const spec = load(readFileSync(path.resolve(__dirname, '../../spec/errors.yaml'), 'utf-8')) as {
  classes: Array<{ id: string; exitCode: number }>
  redaction: { patterns: string[] }
}

describe('spec/errors.yaml and the code agree', () => {
  it('declares every error class the code has, with the same exit code', () => {
    const mismatches: string[] = []
    for (const c of spec.classes) {
      const Ctor = (errors as Record<string, unknown>)[c.id] as (new (m: string) => { exitCode: number }) | undefined
      if (typeof Ctor !== 'function') { mismatches.push(`${c.id}: no such class in src/errors`); continue }
      const code = new Ctor('probe').exitCode
      if (code !== c.exitCode) mismatches.push(`${c.id}: spec says ${c.exitCode}, code says ${code}`)
    }
    expect(mismatches).toEqual([])
  })

  it('has no error class the spec does not declare', () => {
    const declared = new Set(spec.classes.map((c) => c.id))
    const inCode = Object.keys(errors).filter((k) => /Error$/.test(k) && k !== 'ClawopsError')
    expect(inCode.filter((k) => !declared.has(k))).toEqual([])
  })

  it('redacts every sensitive pattern the spec names, in the MCP audit log', () => {
    const uncovered = spec.redaction.patterns
      .map((p) => p.replace(/^\*\./, '').toLowerCase())
      .filter((p) => !SENSITIVE_KEYS.some((s) => p.includes(s)))
    expect(uncovered).toEqual([])
  })
})
