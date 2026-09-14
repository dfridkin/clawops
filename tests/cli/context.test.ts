// Unit tests for buildContext() in src/cli/context.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { withTempConfig, MINIMAL_CONFIG } from '../helpers/config.js'
import type { ClawopsConfig } from '../../src/config/store.js'

const MOCK_LOCAL_STATE = {
  instanceId: 'local:10.0.0.1',
  publicIp: '10.0.0.1',
  gatewayUrl: 'http://10.0.0.1:18789',
  sshHost: '10.0.0.1',
  sshPort: 22,
  sshUser: 'root',
  region: 'local',
  provisionedAt: '2026-05-06T00:00:00.000Z',
  privateKeyPath: '/tmp/id_ed25519',
  knownHostsPath: '/tmp/known_hosts',
}

const mockReadLocalState = vi.fn()

vi.mock('../../src/providers/local/state.js', () => ({
  readLocalState: mockReadLocalState,
}))

vi.mock('../../src/pulumi/automation.js', () => ({
  getOrCreateStack: vi.fn().mockResolvedValue({ outputs: vi.fn() }),
}))

const LOCAL_CONFIG: ClawopsConfig = {
  ...MINIMAL_CONFIG,
  defaults: { stack: 'local-stack', provider: 'local' },
  stacks: {
    'local-stack': {
      provider: 'local',
      stateUrl: 'file://~/.clawops/state',
      credentialsRef: { source: 'file', envVars: [] },
      localOpts: { host: '10.0.0.1', sshUser: 'root', sshPort: 22, sshKeyPath: '/tmp/id_ed25519' },
    },
  },
}

describe('buildContext()', () => {
  beforeEach(() => {
    vi.resetModules()
    mockReadLocalState.mockReset()
  })

  it('sets localState to undefined for a cloud provider', async () => {
    const { buildContext } = await import('../../src/cli/context.js')
    await withTempConfig(async () => {
      const ctx = buildContext({})
      expect(ctx.localState).toBeUndefined()
    })
  })

  it('calls readLocalState and stores the result for a local provider', async () => {
    const { buildContext } = await import('../../src/cli/context.js')
    mockReadLocalState.mockReturnValue(MOCK_LOCAL_STATE)

    await withTempConfig(LOCAL_CONFIG, async () => {
      const ctx = buildContext({})
      expect(mockReadLocalState).toHaveBeenCalledWith('local-stack')
      expect(ctx.localState).toEqual(MOCK_LOCAL_STATE)
    })
  })

  it('stores null localState when host has not been bootstrapped', async () => {
    const { buildContext } = await import('../../src/cli/context.js')
    mockReadLocalState.mockReturnValue(null)

    await withTempConfig(LOCAL_CONFIG, async () => {
      const ctx = buildContext({})
      expect(ctx.localState).toBeNull()
    })
  })

  it('getStack() throws UsageError for local provider', async () => {
    const { buildContext } = await import('../../src/cli/context.js')
    mockReadLocalState.mockReturnValue(null)
    const { UsageError } = await import('../../src/errors/index.js')

    await withTempConfig(LOCAL_CONFIG, async () => {
      const ctx = buildContext({})
      await expect(ctx.getStack()).rejects.toBeInstanceOf(UsageError)
    })
  })

  it('getStack() on cloud provider calls getOrCreateStack', async () => {
    const { buildContext } = await import('../../src/cli/context.js')
    const { getOrCreateStack } = await import('../../src/pulumi/automation.js')

    await withTempConfig(async () => {
      const ctx = buildContext({})
      await ctx.getStack()
      expect(getOrCreateStack).toHaveBeenCalledTimes(1)
    })
  })

  it('stackName defaults to config default when --stack not provided', async () => {
    const { buildContext } = await import('../../src/cli/context.js')

    await withTempConfig(async () => {
      const ctx = buildContext({})
      expect(ctx.stackName).toBe('default')
    })
  })

  it('stackName is overridden by --stack arg', async () => {
    const configWithExtra: ClawopsConfig = {
      ...MINIMAL_CONFIG,
      stacks: {
        ...MINIMAL_CONFIG.stacks,
        staging: {
          provider: 'gcp',
          stateUrl: 'gs://test/clawops',
          region: 'us-east1',
          credentialsRef: { source: 'env', envVars: ['GOOGLE_APPLICATION_CREDENTIALS'] },
        },
      },
    }
    const { buildContext } = await import('../../src/cli/context.js')

    await withTempConfig(configWithExtra, async () => {
      const ctx = buildContext({ stack: 'staging' })
      expect(ctx.stackName).toBe('staging')
    })
  })

  it('getStack() is cached — getOrCreateStack called only once on repeated calls', async () => {
    const { buildContext } = await import('../../src/cli/context.js')
    const { getOrCreateStack } = await import('../../src/pulumi/automation.js')
    vi.mocked(getOrCreateStack).mockClear()

    await withTempConfig(async () => {
      const ctx = buildContext({})
      await ctx.getStack()
      await ctx.getStack()
      expect(getOrCreateStack).toHaveBeenCalledTimes(1)
    })
  })
})

describe('loadAdapterModule', () => {
  it('returns an adapter whose synchronous methods work immediately', async () => {
    const { loadAdapterModule } = await vi.importActual<typeof import('../../src/cli/context.js')>(
      '../../src/cli/context.js',
    )
    const adapter = await loadAdapterModule('gcp')
    // `buildContext().adapter` cannot do this until something async has loaded the module:
    // it throws "Provider not yet loaded". `clawops up` only works because it happens to
    // await validateConfig() first; plan did not, and died at plan time on a real deploy.
    expect(adapter.normalizeInstanceType('small')).toBe('e2-standard-2')
    expect(adapter.name).toBe('gcp')
  })

  it('loads each supported provider', async () => {
    const { loadAdapterModule } = await vi.importActual<typeof import('../../src/cli/context.js')>(
      '../../src/cli/context.js',
    )
    for (const name of ['aws', 'gcp', 'azure', 'local'] as const) {
      expect((await loadAdapterModule(name)).name).toBe(name)
    }
  })

  it('refuses an unknown provider by name', async () => {
    const { loadAdapterModule } = await vi.importActual<typeof import('../../src/cli/context.js')>(
      '../../src/cli/context.js',
    )
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      loadAdapterModule('digitalocean' as any),
    ).rejects.toThrow(/not yet supported/)
  })

  it('maps each size to something distinct per provider', async () => {
    const { loadAdapterModule } = await vi.importActual<typeof import('../../src/cli/context.js')>(
      '../../src/cli/context.js',
    )
    for (const name of ['aws', 'gcp', 'azure'] as const) {
      const adapter = await loadAdapterModule(name)
      const sizes = (['micro', 'small', 'medium', 'large'] as const).map((a) =>
        adapter.normalizeInstanceType(a),
      )
      // A table that collapses two sizes onto one machine type silently ignores the flag.
      expect(new Set(sizes).size).toBe(sizes.length)
      for (const size of sizes) expect(size).not.toMatch(/^(micro|small|medium|large|gpu)$/)
    }
  })
})

describe('the adapter is usable the moment the context exists', () => {
  /**
   * The regression this file did not have. `buildContext().adapter` used to be a proxy whose
   * synchronous methods threw "Provider not yet loaded. Call getStack() first." until
   * something async had loaded the module. Eighteen call sites depended on that ordering:
   * `clawops up` awaits validateConfig() first and worked, `clawops plan` did not, and
   * `doctor --stack`, `ssh`, `logs` and `gateway restart` all failed against a running
   * instance with an error about provider loading rather than about the instance.
   */
  it('answers getConnectionInfo with no await first', async () => {
    await withTempConfig(MINIMAL_CONFIG, async () => {
      const { buildContext } = await import('../../src/cli/context.js')
      const ctx = buildContext({ stack: 'default', provider: 'gcp' })
      const conn = ctx.adapter.getConnectionInfo({
        instanceId: 'i-1',
        publicIp: '203.0.113.4',
        gatewayUrl: 'https://203.0.113.4:18789',
        region: 'us-central1',
        provisionedAt: '2026-09-14T00:00:00.000Z',
        sshHost: '203.0.113.4',
        sshPort: 22,
        sshUser: 'clawops',
        privateKeyPath: '/tmp/key',
        knownHostsPath: '/tmp/known_hosts',
      })
      expect(conn.host).toBe('203.0.113.4')
    })
  })

  it('answers normalizeInstanceType and defaultRegion with no await first', async () => {
    await withTempConfig(MINIMAL_CONFIG, async () => {
      const { buildContext } = await import('../../src/cli/context.js')
      const ctx = buildContext({ stack: 'default', provider: 'gcp' })
      expect(ctx.adapter.normalizeInstanceType('small')).toBe('e2-standard-2')
      expect(ctx.adapter.defaultRegion()).toBeTruthy()
    })
  })

  it('still refuses a provider that does not exist', async () => {
    await withTempConfig(MINIMAL_CONFIG, async () => {
      const { buildContext } = await import('../../src/cli/context.js')
      const { UsageError } = await import('../../src/errors/index.js')
      expect(() => buildContext({ stack: 'default', provider: 'digitalocean' })).toThrow(UsageError)
    })
  })
})
