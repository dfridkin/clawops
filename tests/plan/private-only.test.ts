import { describe, it, expect, vi } from 'vitest'
import {
  privateOnlyNetwork,
  assertTailnetReachable,
  guardPrivateOnlyApply,
} from '../../src/plan/private-only.js'
import type { ClawopsContext } from '../../src/cli/context.js'
import type { DeployPlan } from '../../src/plan/generate.js'

const TAILNET = { ip: '100.96.109.52', verifiedAt: '2026-09-22T00:00:00.000Z' }

const OUTPUTS = {
  instanceId: { value: 'i-0abc' },
  publicIp: { value: '34.200.67.239' },
  gatewayUrl: { value: 'http://34.200.67.239:18789' },
  region: { value: 'us-east-1' },
  provisionedAt: { value: '2026-09-22T00:00:00.000Z' },
  sshHost: { value: '34.200.67.239' },
  sshPort: { value: 22 },
  sshUser: { value: 'ubuntu' },
}

/** A context as buildContext hands it back for a stack with an override: the adapter answers with the tailnet address. */
function ctxWith(tailscale: typeof TAILNET | undefined, outputs: () => Promise<unknown> = async () => OUTPUTS): ClawopsContext {
  return {
    config: {
      version: 1,
      defaults: { stack: 'prod', provider: 'aws' },
      stacks: {
        prod: {
          provider: 'aws',
          stateUrl: 's3://b',
          credentialsRef: { source: 'cli-profile' },
          ...(tailscale ? { tailscale } : {}),
        },
      },
      ssh: { keyPath: '/k', knownHostsPath: '/kh' },
    },
    adapter: {
      getConnectionInfo: (o: Record<string, unknown>) => ({
        host: tailscale ? tailscale.ip : String(o['sshHost']),
        port: Number(o['sshPort']),
        user: String(o['sshUser']),
        privateKeyPath: String(o['privateKeyPath']),
        knownHostsPath: String(o['knownHostsPath']),
      }),
    },
    stackName: 'prod',
    getStack: async () => ({ outputs }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- only the slices read here
  } as any
}

function planWith(network: DeployPlan['spec']['network']): DeployPlan {
  return { spec: { stackName: 'prod', network } } as DeployPlan
}

describe('privateOnlyNetwork', () => {
  it('closes both public ingress lists and records the address that remains', () => {
    const net = privateOnlyNetwork({}, { allowedSshCidrs: [], allowedGatewayCidrs: [] }, TAILNET, 'prod')
    expect(net).toEqual({
      allowedSshCidrs: [],
      allowedGatewayCidrs: [],
      tailscale: { enabled: true, privateOnly: true, ip: TAILNET.ip },
    })
  })

  it('keeps the publish choice, which is about the host, not the firewall', () => {
    const net = privateOnlyNetwork({ publishGateway: 'all' }, { allowedSshCidrs: [], allowedGatewayCidrs: [], publishGateway: 'all' }, TAILNET, 'prod')
    expect(net.publishGateway).toBe('all')
  })

  it.each([
    [{ sshCidr: '203.0.113.4/32' }],
    [{ gatewayCidr: 'auto' }],
    // An empty value is still a public rule asked for, and still a contradiction.
    [{ sshCidr: '' }],
  ])('refuses a public rule alongside it: %j', (flags) => {
    expect(() => privateOnlyNetwork(flags, { allowedSshCidrs: [], allowedGatewayCidrs: [] }, TAILNET, 'prod'))
      .toThrow(/cannot be combined/)
  })

  it('refuses a stack with no verified tailnet address', () => {
    expect(() => privateOnlyNetwork({}, { allowedSshCidrs: [], allowedGatewayCidrs: [] }, undefined, 'prod'))
      .toThrow(/harden --tailscale/)
  })
})

describe('assertTailnetReachable', () => {
  it('probes the tailnet address with the stack\'s own port and user', async () => {
    const probe = vi.fn().mockResolvedValue(true)
    await expect(assertTailnetReachable(ctxWith(TAILNET), probe)).resolves.toBe(TAILNET.ip)
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ host: TAILNET.ip, port: 22, user: 'ubuntu', knownHostsPath: '/kh' }))
  })

  it('refuses when the tailnet does not answer: that is the lockout', async () => {
    await expect(assertTailnetReachable(ctxWith(TAILNET), async () => false)).rejects.toThrow(/cannot reach .* 100\.96\.109\.52/)
  })

  it('refuses without probing when there is no override', async () => {
    const probe = vi.fn()
    await expect(assertTailnetReachable(ctxWith(undefined), probe)).rejects.toThrow(/no verified tailnet address/)
    expect(probe).not.toHaveBeenCalled()
  })

  it('refuses a stack with nothing deployed', async () => {
    const probe = vi.fn()
    await expect(assertTailnetReachable(ctxWith(TAILNET, async () => { throw new Error('no stack') }), probe))
      .rejects.toThrow(/no deployment/)
    expect(probe).not.toHaveBeenCalled()
  })
})

describe('guardPrivateOnlyApply', () => {
  const PRIVATE = { allowedSshCidrs: [], allowedGatewayCidrs: [], tailscale: { enabled: true, privateOnly: true, ip: TAILNET.ip } }

  it('leaves an ordinary plan alone, override or not', async () => {
    const probe = vi.fn()
    await guardPrivateOnlyApply(planWith({ allowedSshCidrs: ['203.0.113.4/32'], allowedGatewayCidrs: [] }), ctxWith(TAILNET), probe)
    expect(probe).not.toHaveBeenCalled()
  })

  it('passes a private plan whose tailnet address answers', async () => {
    const probe = vi.fn().mockResolvedValue(true)
    await guardPrivateOnlyApply(planWith(PRIVATE), ctxWith(TAILNET), probe)
    expect(probe).toHaveBeenCalledOnce()
  })

  it('refuses a private plan when the tailnet has gone away since it was made', async () => {
    await expect(guardPrivateOnlyApply(planWith(PRIVATE), ctxWith(TAILNET), async () => false)).rejects.toThrow(/cannot reach/)
  })

  it('refuses a hand-edited plan that is marked private but opens a port', async () => {
    const probe = vi.fn()
    await expect(guardPrivateOnlyApply(planWith({ ...PRIVATE, allowedSshCidrs: ['0.0.0.0/0'] }), ctxWith(TAILNET), probe))
      .rejects.toThrow(/still opens public ports/)
    expect(probe).not.toHaveBeenCalled()
  })

  it('refuses a plan made for an address the stack no longer has', async () => {
    const probe = vi.fn()
    await expect(guardPrivateOnlyApply(planWith(PRIVATE), ctxWith({ ...TAILNET, ip: '100.64.0.9' }), probe))
      .rejects.toThrow(/made for the tailnet address 100\.96\.109\.52/)
    expect(probe).not.toHaveBeenCalled()
  })

  it('refuses when the override has been removed since planning', async () => {
    await expect(guardPrivateOnlyApply(planWith(PRIVATE), ctxWith(undefined), vi.fn())).rejects.toThrow(/no verified tailnet address/)
  })
})
