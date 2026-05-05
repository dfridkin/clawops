import { describe, it, expect } from 'vitest'
import {
  clawops_statusSchema,
  clawops_upSchema,
  clawops_destroySchema,
  clawops_workflow_deploy_appSchema,
  TOOLSETS,
} from '../../src/mcp/tools/_generated'

describe('MCP tool schemas', () => {
  it('clawops_status accepts empty input', () => {
    const result = clawops_statusSchema.safeParse({})
    expect(result.success).toBe(true)
  })

  it('clawops_status accepts optional stackName', () => {
    const result = clawops_statusSchema.safeParse({ stackName: 'prod' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.stackName).toBe('prod')
  })

  it('clawops_up applies instanceType default', () => {
    const result = clawops_upSchema.safeParse({})
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.instanceType).toBe('small')
  })

  it('clawops_up rejects unknown instanceType', () => {
    const result = clawops_upSchema.safeParse({ instanceType: 'xlarge' })
    expect(result.success).toBe(false)
  })

  it('clawops_destroy requires stackName', () => {
    const missing = clawops_destroySchema.safeParse({})
    expect(missing.success).toBe(false)

    const present = clawops_destroySchema.safeParse({ stackName: 'my-stack' })
    expect(present.success).toBe(true)
  })

  it('clawops_workflow_deploy_app requires provider', () => {
    const missing = clawops_workflow_deploy_appSchema.safeParse({})
    expect(missing.success).toBe(false)

    const valid = clawops_workflow_deploy_appSchema.safeParse({ provider: 'gcp' })
    expect(valid.success).toBe(true)
    if (valid.success) {
      expect(valid.data.stackName).toBe('default')
      expect(valid.data.instanceType).toBe('small')
    }
  })

  it('TOOLSETS contains expected entries', () => {
    expect(TOOLSETS.read).toContain('clawops_status')
    expect(TOOLSETS.cli).toContain('clawops_up')
    expect(TOOLSETS.workflow).toContain('clawops_workflow_deploy_app')
    expect(TOOLSETS.admin).toContain('clawops_stacks_list')
  })
})
