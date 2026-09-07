// Pulumi component tests using pulumi.runtime.setMocks().
// Validates that each component wires outputs correctly without real cloud calls.

import * as pulumi from '@pulumi/pulumi'
import { describe, it, expect, beforeAll } from 'vitest'

beforeAll(() => {
  pulumi.runtime.setMocks(
    {
      newResource(args) {
        const baseOutputs: Record<string, Record<string, unknown>> = {
          // command.remote.Command
          'command:remote:Command': { stdout: 'abc123\n', stderr: '' },
        }
        return {
          id: `${args.name}-id`,
          state: { ...args.inputs, ...(baseOutputs[args.type] ?? {}) },
        }
      },
      call(args) {
        return args.inputs
      },
    },
    'project',
    'test',
    /* preview */ false,
  )
})

async function resolveOutput<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise((resolve) => {
    output.apply(resolve)
  })
}

describe('Server component', () => {
  it('registers instanceId, publicIp, sshHost outputs', async () => {
    const { Server } = await import('../../src/pulumi/components/server.js')
    const server = new Server('test-server', {
      instanceType: 't3.small',
      region: 'us-east-1',
      sshPublicKey: 'ssh-ed25519 AAAA...',
      imageId: 'ami-0abc123',
    })

    const instanceId = await resolveOutput(server.instanceId)
    const publicIp = await resolveOutput(server.publicIp)
    const sshHost = await resolveOutput(server.sshHost)

    expect(typeof instanceId).toBe('string')
    expect(instanceId.length).toBeGreaterThan(0)
    expect(typeof publicIp).toBe('string')
    expect(sshHost).toBe(publicIp)
  })
})

describe('Network component', () => {
  it('registers resourceIds, sshCidrs, gatewayCidrs outputs', async () => {
    const { Network } = await import('../../src/pulumi/components/network.js')
    const net = new Network('test-net', {
      allowedSshCidrs: ['10.0.0.1/32'],
      allowedGatewayCidrs: ['10.0.0.0/24'],
    })

    const resourceIds = await resolveOutput(net.resourceIds)
    const sshCidrs = await resolveOutput(net.sshCidrs)
    const gatewayCidrs = await resolveOutput(net.gatewayCidrs)

    expect(Array.isArray(resourceIds)).toBe(true)
    expect(Array.isArray(sshCidrs)).toBe(true)
    expect(sshCidrs).toContain('10.0.0.1/32')
    expect(gatewayCidrs).toContain('10.0.0.0/24')
  })
})

describe('Secrets component', () => {
  it('registers gatewayTokenRef output containing the stack name', async () => {
    const { Secrets } = await import('../../src/pulumi/components/secrets.js')
    const secrets = new Secrets('test-secrets', {
      backend: 'aws-ssm',
      stackName: 'prod',
      gatewayToken: 'tok-abc',
      region: 'us-east-1',
    })

    const ref = await resolveOutput(secrets.gatewayTokenRef)
    expect(ref).toContain('prod')
    expect(typeof ref).toBe('string')
  })
})
