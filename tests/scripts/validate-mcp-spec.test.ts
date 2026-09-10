import { describe, it, expect } from 'vitest'
import { validateMcpSpec, type McpSpec, type Tool } from '../../scripts/lib/validate-mcp-spec.js'

// The generator used to cast the parsed YAML with `as McpSpec` and generate from it. A cast
// checks nothing: a tool missing readOnlyHint generated `readOnlyHint: undefined`, which
// compiles and ships, and the client falls back to defaults — R10 defeated with no error
// anywhere. These assert the validator actually rejects each shape.

function tool(over: Partial<Tool> = {}): Tool {
  return {
    name: 'clawops_thing',
    toolset: ['cli'],
    description: 'Does a thing.\n\nUse when: you want the thing.',
    annotations: {
      title: 'Thing',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    ...over,
  }
}

function spec(tools: Tool[]): McpSpec {
  return {
    version: 1,
    toolsets: [{ id: 'cli', description: '' }, { id: 'read', description: '' },
               { id: 'workflow', description: '' }, { id: 'admin', description: '' }],
    tools,
  }
}

const rejects = (t: Tool, pattern: RegExp) =>
  expect(() => validateMcpSpec(spec([t]))).toThrow(pattern)

describe('validateMcpSpec', () => {
  it('accepts a well-formed tool', () => {
    expect(() => validateMcpSpec(spec([tool()]))).not.toThrow()
  })

  it.each(['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const)(
    'rejects a missing %s',
    (hint) => {
      const t = tool()
      delete (t.annotations as Record<string, unknown>)[hint]
      rejects(t, new RegExp(hint))
    },
  )

  it('rejects a hint that is a string rather than a boolean', () => {
    const t = tool()
    ;(t.annotations as Record<string, unknown>)['readOnlyHint'] = 'true'
    rejects(t, /readOnlyHint/)
  })

  it('rejects a missing annotations block outright', () => {
    const t = tool()
    delete (t as Partial<Tool>).annotations
    rejects(t, /annotations/)
  })

  it('rejects an empty title', () => {
    rejects(tool({ annotations: { ...tool().annotations, title: '  ' } }), /title/)
  })

  it('rejects a name without the clawops_ prefix', () => {
    rejects(tool({ name: 'status' }), /clawops_/)
  })

  it('rejects a camelCase name', () => {
    rejects(tool({ name: 'clawops_configGet' }), /snake_case|clawops_/)
  })

  it('rejects a duplicate declaration', () => {
    expect(() => validateMcpSpec(spec([tool(), tool()]))).toThrow(/twice/)
  })

  it('rejects an unknown toolset', () => {
    rejects(tool({ toolset: ['clu'] }), /unknown toolset/)
  })

  it('rejects a tool in no toolset', () => {
    rejects(tool({ toolset: [] }), /at least one toolset/)
  })

  it('rejects read-only and destructive at once', () => {
    rejects(
      tool({
        toolset: ['cli', 'read'],
        annotations: { ...tool().annotations, readOnlyHint: true, destructiveHint: true },
      }),
      /cannot both be true/,
    )
  })

  it('rejects a read-only tool left out of the read toolset', () => {
    // R18: --read-only enables the read toolset. A read-only tool outside it disappears in
    // the very mode meant to allow it.
    rejects(
      tool({ toolset: ['cli'], annotations: { ...tool().annotations, readOnlyHint: true } }),
      /"read" toolset/,
    )
  })

  it('rejects a writing tool placed in the read toolset', () => {
    // The dangerous direction: --read-only would admit it.
    rejects(tool({ toolset: ['cli', 'read'] }), /readOnlyHint is false/)
  })

  it('rejects a description that never says when to use it', () => {
    rejects(tool({ description: 'Does a thing.' }), /Use when/)
  })

  it('rejects more than 30 tools (R1)', () => {
    const many = Array.from({ length: 31 }, (_, i) => tool({ name: `clawops_thing_${i}` }))
    expect(() => validateMcpSpec(spec(many))).toThrow(/caps the catalog at 30/)
  })

  it('rejects more than 3 workflow tools (R2)', () => {
    const four = Array.from({ length: 4 }, (_, i) =>
      tool({ name: `clawops_workflow_${i}`, toolset: ['workflow'] }),
    )
    expect(() => validateMcpSpec(spec(four))).toThrow(/caps them at 3/)
  })

  it('reports every problem at once, not just the first', () => {
    const t = tool({ name: 'bad', description: 'nope' })
    delete (t.annotations as Record<string, unknown>)['openWorldHint']
    try {
      validateMcpSpec(spec([t]))
      throw new Error('should have thrown')
    } catch (err) {
      const msg = (err as Error).message
      expect(msg).toMatch(/clawops_/)
      expect(msg).toMatch(/openWorldHint/)
      expect(msg).toMatch(/Use when/)
    }
  })

  it('validates the real catalog', async () => {
    const { readFileSync } = await import('node:fs')
    const yaml = (await import('js-yaml')).default
    const real = yaml.load(readFileSync('spec/mcp-tools.yaml', 'utf-8')) as McpSpec
    expect(() => validateMcpSpec(real)).not.toThrow()
  })
})
