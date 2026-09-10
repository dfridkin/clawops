// Catalog validation for spec/mcp-tools.yaml.
//
// Lives apart from gen-schemas.ts so it can be tested: that file generates on import, so a
// test importing it would rewrite the tree. An unexercised validator is worth about as much
// as no validator.

export interface ToolInput {
  type: string
  optional?: boolean
  description?: string
  default?: unknown
  values?: string[]
  max?: number
  minimum?: number
  maximum?: number
}

export interface Tool {
  name: string
  toolset: string | string[]
  description: string
  annotations: {
    title: string
    readOnlyHint: boolean
    destructiveHint: boolean
    idempotentHint: boolean
    openWorldHint: boolean
  }
  input?: Record<string, ToolInput>
}

export interface McpSpec {
  version: number
  toolsets: Array<{ id: string; description: string }>
  tools: Tool[]
}

/**
 * Validate the catalog before generating from it.
 *
 * `as McpSpec` is a claim, not a check: a tool missing `readOnlyHint` used to generate
 * `readOnlyHint: undefined`, which compiles, ships, and leaves the client falling back to
 * its defaults — the exact outcome R10 exists to prevent, arrived at silently. A tool
 * declared but never registered is the other half: it appears in the catalog and fails
 * when called.
 */
const HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const

export function validateMcpSpec(spec: McpSpec): void {
  const problems: string[] = []
  const known = new Set(spec.toolsets.map(ts => ts.id))
  const seen = new Set<string>()

  for (const tool of spec.tools) {
    const at = tool.name ?? '(unnamed tool)'

    // R1 — prefix and shape.
    if (!/^clawops_[a-z0-9]+(_[a-z0-9]+)*$/.test(at)) {
      problems.push(`${at}: name must match clawops_<verb> or clawops_<noun>_<verb>, lower_snake_case`)
    }
    if (seen.has(at)) problems.push(`${at}: declared twice`)
    seen.add(at)

    const toolsets = Array.isArray(tool.toolset) ? tool.toolset : [tool.toolset]
    if (toolsets.length === 0 || toolsets.some(t => !t)) {
      problems.push(`${at}: must belong to at least one toolset`)
    }
    for (const t of toolsets) {
      if (t && !known.has(t)) problems.push(`${at}: unknown toolset "${t}"`)
    }

    // R10 — all four hints, explicitly, plus a title.
    const ann = tool.annotations
    if (!ann) {
      problems.push(`${at}: no annotations block (R10 requires all four hints and a title)`)
    } else {
      if (typeof ann.title !== 'string' || ann.title.trim() === '') {
        problems.push(`${at}: annotations.title must be a non-empty string`)
      }
      for (const hint of HINTS) {
        if (typeof ann[hint] !== 'boolean') {
          problems.push(
            `${at}: annotations.${hint} must be explicitly true or false (R10 — defaults are insufficient)`,
          )
        }
      }
      // R11 — a read-only tool that also claims to destroy is a contradiction the safety
      // modes cannot resolve: --read-only would admit it and --no-destructive would not.
      if (ann.readOnlyHint === true && ann.destructiveHint === true) {
        problems.push(`${at}: readOnlyHint and destructiveHint cannot both be true`)
      }
      if (ann.readOnlyHint === true && !toolsets.includes('read')) {
        problems.push(`${at}: readOnlyHint is true, so it belongs in the "read" toolset (R18)`)
      }
      if (ann.readOnlyHint === false && toolsets.includes('read')) {
        problems.push(`${at}: in the "read" toolset but readOnlyHint is false — --read-only would admit it`)
      }
    }

    // R3 — a description an agent can route on.
    if (!tool.description?.includes('Use when')) {
      problems.push(`${at}: description must say "Use when:" (R3)`)
    }
  }

  // R1 — the catalog is capped so an agent can hold it in context.
  if (spec.tools.length > 30) {
    problems.push(`${spec.tools.length} tools declared; R1 caps the catalog at 30`)
  }
  // R2 — composite tools encode intent; more than three means they are API sequences.
  const workflow = spec.tools.filter(t =>
    (Array.isArray(t.toolset) ? t.toolset : [t.toolset]).includes('workflow'),
  )
  if (workflow.length > 3) {
    problems.push(`${workflow.length} workflow tools; R2 caps them at 3`)
  }

  if (problems.length > 0) {
    throw new Error(
      `spec/mcp-tools.yaml is invalid:\n${problems.map(p => `  - ${p}`).join('\n')}`,
    )
  }
}

