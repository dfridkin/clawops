import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockCreateOrSelect, mockEnsure } = vi.hoisted(() => ({
  mockCreateOrSelect: vi.fn(),
  mockEnsure: vi.fn(),
}))
vi.mock('@pulumi/pulumi/automation', () => ({
  LocalWorkspace: { createOrSelectStack: mockCreateOrSelect },
}))
vi.mock('../../src/pulumi/cli.js', () => ({ ensurePulumiCli: mockEnsure }))
vi.mock('../../src/config/store.js', () => ({ getConfigDir: () => '/default/.clawops' }))

import { getOrCreateStack } from '../../src/pulumi/automation.js'

const PULUMI_COMMAND = { command: '/home/u/.clawops/.pulumi-cli/bin/pulumi' }
const program = async () => ({})

beforeEach(() => {
  mockCreateOrSelect.mockReset().mockResolvedValue({ name: 'stack' })
  mockEnsure.mockReset().mockResolvedValue(PULUMI_COMMAND)
})

function optsOf() {
  return mockCreateOrSelect.mock.calls[0]?.[1] as Record<string, unknown>
}

describe('getOrCreateStack', () => {
  it('hands the workspace a resolved CLI', async () => {
    await getOrCreateStack({
      stack: 'prod',
      stateUrl: 's3://b/clawops',
      program,
      configDir: '/home/u/.clawops',
    })
    // Without this the workspace spawns bare `pulumi` and dies with ENOENT on any machine
    // that has no Pulumi installed — which is the machine clawops is written for.
    expect(optsOf()['pulumiCommand']).toBe(PULUMI_COMMAND)
    expect(mockEnsure).toHaveBeenCalledWith({ configDir: '/home/u/.clawops', onInstall: undefined })
  })

  it('resolves the CLI against the same config dir as the Pulumi home', async () => {
    await getOrCreateStack({ stack: 'prod', stateUrl: 's3://b/clawops', program })
    expect(mockEnsure).toHaveBeenCalledWith({
      configDir: '/default/.clawops',
      onInstall: undefined,
    })
    expect(optsOf()['pulumiHome']).toBe('/default/.clawops/.pulumi')
  })

  it('passes the caller through to the install announcement', async () => {
    const onInstall = vi.fn()
    await getOrCreateStack({ stack: 'prod', stateUrl: 's3://b/clawops', program, onInstall })
    expect(mockEnsure).toHaveBeenCalledWith({ configDir: '/default/.clawops', onInstall })
  })

  it('does not reach the workspace when no CLI can be resolved', async () => {
    mockEnsure.mockRejectedValue(new Error('could not install the Pulumi CLI'))
    await expect(
      getOrCreateStack({ stack: 'prod', stateUrl: 's3://b/clawops', program }),
    ).rejects.toThrow(/could not install the Pulumi CLI/)
    expect(mockCreateOrSelect).not.toHaveBeenCalled()
  })

  it('still sets the stack, project and backend it always set', async () => {
    await getOrCreateStack({ stack: 'prod', stateUrl: 's3://b/clawops', program })
    expect(mockCreateOrSelect.mock.calls[0]?.[0]).toMatchObject({
      stackName: 'prod',
      projectName: 'clawops',
    })
    expect(optsOf()['envVars']).toMatchObject({ PULUMI_BACKEND_URL: 's3://b/clawops' })
  })
})
