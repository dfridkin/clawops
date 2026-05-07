import { describe, it, expect } from 'vitest'
import { resolveEnabledTools } from '../../src/mcp/tools/registry.js'
import { TOOLSETS } from '../../src/mcp/tools/_generated.js'

// We don't need real handlers for these tests — just the filtering logic

describe('resolveEnabledTools', () => {
  it('returns all 15 tools by default', () => {
    const tools = resolveEnabledTools({})
    const expected = [
      ...TOOLSETS.cli,
      ...TOOLSETS.workflow,
      ...TOOLSETS.admin,
    ]
    expect(tools.length).toBe(new Set(expected).size)
    expect(tools).toContain('clawops_status')
    expect(tools).toContain('clawops_up')
    expect(tools).toContain('clawops_destroy')
    expect(tools).toContain('clawops_workflow_deploy_app')
    expect(tools).toContain('clawops_stacks_list')
  })

  it('returns only read toolset when readOnly=true', () => {
    const tools = resolveEnabledTools({ readOnly: true })
    for (const tool of tools) {
      expect(TOOLSETS.read).toContain(tool)
    }
    // Should not contain destructive tools
    expect(tools).not.toContain('clawops_destroy')
    expect(tools).not.toContain('clawops_up')
  })

  it('excludes destructive tools when noDestructive=true', () => {
    const tools = resolveEnabledTools({ noDestructive: true })
    // These are marked destructiveHint: true in _generated.ts
    expect(tools).not.toContain('clawops_destroy')
    // clawops_status is read-only — should remain
    expect(tools).toContain('clawops_status')
  })

  it('respects explicit toolsets list', () => {
    const tools = resolveEnabledTools({ toolsets: ['read'] })
    expect(tools.length).toBeGreaterThan(0)
    for (const tool of tools) {
      expect(TOOLSETS.read).toContain(tool)
    }
  })

  it('deduplicates when toolsets overlap', () => {
    const tools = resolveEnabledTools({ toolsets: ['read', 'cli'] })
    const unique = new Set(tools)
    expect(tools.length).toBe(unique.size)
  })

  it('applies noDestructive filter on top of toolsets', () => {
    const all = resolveEnabledTools({ toolsets: ['cli'] })
    const filtered = resolveEnabledTools({ toolsets: ['cli'], noDestructive: true })
    expect(filtered.length).toBeLessThanOrEqual(all.length)
    expect(filtered).not.toContain('clawops_destroy')
  })

  it('returns empty array for unknown toolset name', () => {
    const tools = resolveEnabledTools({ toolsets: ['nonexistent'] })
    expect(tools).toEqual([])
  })
})

describe('TOOLSETS structure', () => {
  it('read toolset contains only read-safe tools', () => {
    expect(TOOLSETS.read).toContain('clawops_status')
    expect(TOOLSETS.read).toContain('clawops_stacks_list')
    expect(TOOLSETS.read).toContain('clawops_config_get')
    expect(TOOLSETS.read).toContain('clawops_agents_list')
    expect(TOOLSETS.read).toContain('clawops_task_status')
    expect(TOOLSETS.read).not.toContain('clawops_destroy')
    expect(TOOLSETS.read).not.toContain('clawops_up')
  })

  it('cli toolset contains up and destroy', () => {
    expect(TOOLSETS.cli).toContain('clawops_up')
    expect(TOOLSETS.cli).toContain('clawops_destroy')
  })

  it('workflow toolset has at most 3 tools (R2)', () => {
    expect(TOOLSETS.workflow.length).toBeLessThanOrEqual(3)
  })

  it('admin toolset contains stacks_list', () => {
    expect(TOOLSETS.admin).toContain('clawops_stacks_list')
  })
})
