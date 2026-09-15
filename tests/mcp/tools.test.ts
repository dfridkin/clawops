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

  it('clawops_up accepts a provider-native instanceType', () => {
    // It was an enum of the five clawops sizes. Azure offers SKU families per subscription,
    // and an account offered none of those five would have had no way to deploy.
    const result = clawops_upSchema.safeParse({ instanceType: 'Standard_D2als_v7' })
    expect(result.success).toBe(true)
  })

  it('clawops_up takes the network flags a reachable stack needs', () => {
    const result = clawops_upSchema.safeParse({
      sshCidr: 'auto',
      gatewayCidr: '203.0.113.0/24',
      publishGateway: 'all',
    })
    expect(result.success).toBe(true)
  })

  it('clawops_up still rejects a publishGateway it does not understand', () => {
    expect(clawops_upSchema.safeParse({ publishGateway: 'public' }).success).toBe(false)
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
