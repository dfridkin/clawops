import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { TOOL_NAMES } from '../../src/mcp/tools/registry.js'

// spec/mcp-tools.yaml is ground truth (R-meta-1). These assert the things that were only
// ever true by review: that the catalog and the registry agree, and that every tool sets
// the four annotation hints R10 requires.

interface Tool {
  name: string
  toolset: string | string[]
  description?: string
  annotations?: Record<string, unknown>
}
const spec = yaml.load(
  readFileSync(path.join(process.cwd(), 'spec/mcp-tools.yaml'), 'utf-8'),
) as { toolsets: Array<{ id: string }>; tools: Tool[] }

const HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const
const toolsetsOf = (t: Tool) => (Array.isArray(t.toolset) ? t.toolset : [t.toolset])

describe('MCP catalog', () => {
  it('declares every tool the registry serves, and serves every tool it declares', () => {
    // A tool in the catalog with no handler is advertised to agents and throws when
    // called; a handler with no catalog entry is unreachable and untyped.
    expect([...TOOL_NAMES].sort()).toEqual(spec.tools.map((t) => t.name).sort())
  })

  it.each(spec.tools.map((t) => [t.name, t] as const))(
    '%s sets all four annotation hints and a title',
    (_name, tool) => {
      expect(typeof tool.annotations?.['title']).toBe('string')
      expect(String(tool.annotations?.['title'])).not.toBe('')
      for (const hint of HINTS) {
        // Explicitly boolean. A missing hint generates `undefined`, which compiles and
        // leaves the client on its own defaults — R10 violated with nothing to see.
        expect(typeof tool.annotations?.[hint], `${_name}.${hint}`).toBe('boolean')
      }
    },
  )

  it.each(spec.tools.map((t) => [t.name, t] as const))(
    '%s belongs to declared toolsets, consistent with its read-only hint',
    (_name, tool) => {
      const known = new Set(spec.toolsets.map((ts) => ts.id))
      const sets = toolsetsOf(tool)
      expect(sets.length).toBeGreaterThan(0)
      for (const s of sets) expect(known).toContain(s)

      // R18: --read-only enables exactly the `read` toolset. If the two disagree, the
      // safety mode either hides a read-only tool or admits a writing one.
      expect(sets.includes('read'), `${_name} read toolset`).toBe(
        tool.annotations?.['readOnlyHint'] === true,
      )
    },
  )

  it.each(spec.tools.map((t) => [t.name, t] as const))('%s says when to use it (R3)', (_n, tool) => {
    expect(tool.description ?? '').toContain('Use when')
  })

  it('stays inside the R1 catalog cap', () => {
    expect(spec.tools.length).toBeLessThanOrEqual(30)
  })

  it('stays inside the R2 composite-tool cap', () => {
    expect(spec.tools.filter((t) => toolsetsOf(t).includes('workflow')).length).toBeLessThanOrEqual(3)
  })

  it('never marks a tool both read-only and destructive', () => {
    for (const tool of spec.tools) {
      const a = tool.annotations ?? {}
      expect(a['readOnlyHint'] === true && a['destructiveHint'] === true, tool.name).toBe(false)
    }
  })
})

describe('documented tool tables', () => {
  // README and the risk matrix each carried a table of tools maintained by hand. By 2.0
  // the README listed clawops_ssh_exec and clawops_agents_restart — neither of which
  // exists — and omitted five that do; the risk matrix said "All 15 tools" above sixteen
  // rows, and marked three tools unavailable in --read-only that the catalog puts in the
  // read toolset. A table that disagrees with the server is worse than no table.
  const NAMES = new Set(spec.tools.map((t) => t.name))

  const docs = [
    ['README.md', 'README.md'],
    ['tool risk matrix', 'docs/security/tool-risk-matrix.md'],
  ] as const

  /**
   * Tools named in a table row, not in prose. A release note explaining that
   * `clawops_agents_restart` was removed is correct and must stay; a table row claiming to
   * serve it is not.
   */
  function tableRows(file: string): string[] {
    const text = readFileSync(path.join(process.cwd(), file), 'utf-8')
    return [...text.matchAll(/^\| `(clawops_[a-z0-9_]+)` \|/gm)].map((m) => m[1]!)
  }

  it.each(docs)('%s lists every tool in the catalog', (_label, file) => {
    const listed = new Set(tableRows(file))
    expect([...NAMES].filter((n) => !listed.has(n)), `${file} is missing`).toEqual([])
  })

  it.each(docs)('%s tabulates no tool the catalog does not declare', (_label, file) => {
    const phantom = [...new Set(tableRows(file))].filter((n) => !NAMES.has(n))
    expect(phantom, `${file} tabulates tools that do not exist`).toEqual([])
  })

  it('the risk matrix agrees with the catalog on --read-only availability', () => {
    const text = readFileSync(path.join(process.cwd(), 'docs/security/tool-risk-matrix.md'), 'utf-8')
    for (const tool of spec.tools) {
      const row = text.split('\n').find((l) => l.startsWith(`| \`${tool.name}\` |`))
      expect(row, `no risk-matrix row for ${tool.name}`).toBeDefined()
      const cells = row!.split('|').map((c) => c.trim())
      // | name | toolset | risk | --read-only | --no-destructive | default |
      expect(cells[4] === '✅', `${tool.name} --read-only`).toBe(toolsetsOf(tool).includes('read'))
      expect(cells[5] === '✅', `${tool.name} --no-destructive`).toBe(
        tool.annotations?.['destructiveHint'] !== true,
      )
    }
  })

  it('the risk matrix states the right tool count', () => {
    const text = readFileSync(path.join(process.cwd(), 'docs/security/tool-risk-matrix.md'), 'utf-8')
    expect(text).toContain(`All ${spec.tools.length} clawops MCP tools`)
  })

  it('read-only mode docs list exactly the read toolset', () => {
    // docs/mcp/read-only.md is what a user reads before deciding to trust the mode. It
    // listed 8 tools when the toolset held 11, so three tools an agent can call in
    // --read-only were undocumented.
    const readTools = spec.tools.filter((t) => toolsetsOf(t).includes('read')).map((t) => t.name)
    const text = readFileSync(path.join(process.cwd(), 'docs/mcp/read-only.md'), 'utf-8')
    const listed = [...text.matchAll(/^\| `(clawops_[a-z0-9_]+)` \|/gm)].map((m) => m[1]!)
    expect(listed.sort()).toEqual([...readTools].sort())
    expect(text).toContain(`**${readTools.length} tools**`)
  })

  it('the safety-mode docs state the right counts', () => {
    const text = readFileSync(path.join(process.cwd(), 'docs/security/mcp-safety.md'), 'utf-8')
    const readCount = spec.tools.filter((t) => toolsetsOf(t).includes('read')).length
    const destructive = spec.tools.filter((t) => t.annotations?.['destructiveHint'] === true)
    expect(text).toContain(`**${readCount} tools**`)
    expect(text).toContain(`all **${spec.tools.length} tools**`)
    expect(text).toContain(`the ${destructive.length} destructive ones`)
    // And names each one, so the list cannot rot away from the count.
    for (const t of destructive) expect(text).toContain(`\`${t.name}\``)
  })

  it('full access is described as the whole catalog', () => {
    const text = readFileSync(path.join(process.cwd(), 'docs/mcp/read-only.md'), 'utf-8')
    expect(text).toContain(`enable all ${spec.tools.length} tools`)
  })

})
