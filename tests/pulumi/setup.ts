// Shared Pulumi mock setup — import this at the top of any Pulumi unit test.
// Per SPEC §4.2 and Issue 9: centralise setMocks() to avoid repetition.

import * as pulumi from '@pulumi/pulumi'

export interface MockResource {
  type: string
  name: string
  inputs: Record<string, unknown>
}

const captured: MockResource[] = []

export function getCapturedResources(): MockResource[] {
  return [...captured]
}

export function clearCapturedResources(): void {
  captured.length = 0
}

/**
 * Initialise Pulumi mocks.
 * Call once per test file (outside describe blocks) — Pulumi's setMocks is global.
 *
 * @param customOutputs Optional map of resource type → extra outputs to merge.
 */
export function setupPulumiMocks(
  customOutputs: Record<string, Record<string, unknown>> = {},
): void {
  pulumi.runtime.setMocks(
    {
      newResource(args: pulumi.runtime.MockResourceArgs): { id: string; state: Record<string, unknown> } {
        captured.push({ type: args.type, name: args.name, inputs: args.inputs })

        const baseOutputs: Record<string, Record<string, unknown>> = {
          'gcp:compute/network:Network': { id: 'network-mock', selfLink: 'https://mock/network' },
          'gcp:compute/subnetwork:Subnetwork': { id: 'subnet-mock' },
          'gcp:compute/firewall:Firewall': { id: 'firewall-mock' },
          'gcp:compute/address:Address': { id: 'address-mock', address: '1.2.3.4' },
          'gcp:compute/instance:Instance': {
            id: 'instance-mock',
            networkInterfaces: [{ accessConfigs: [{ natIp: '1.2.3.4' }] }],
          },
          'aws:ec2/instance:Instance': { id: 'i-mock', publicIp: '1.2.3.4' },
        }

        const merged = {
          ...(baseOutputs[args.type] ?? {}),
          ...(customOutputs[args.type] ?? {}),
          ...args.inputs,
        }

        return { id: `${args.name}-id`, state: merged }
      },
      call(args: pulumi.runtime.MockCallArgs): Record<string, unknown> {
        return args.inputs
      },
    },
    'test-project',
    'test-stack',
  )
}
