// Shared fake ClawopsContext for command unit tests.
// Provides pre-wired fake stack outputs so command tests don't need Pulumi.

import { vi } from 'vitest'
import { MINIMAL_CONFIG } from './config.js'
import type { ClawopsContext } from '../../src/cli/context.js'
import type { BaseStackOutputs } from '../../src/pulumi/outputs.js'
import type { LocalState } from '../../src/providers/local/state.js'

export const FAKE_BASE_OUTPUTS: BaseStackOutputs = {
  instanceId: 'i-test-123',
  publicIp: '1.2.3.4',
  gatewayUrl: 'https://1.2.3.4:18789',
  sshHost: '1.2.3.4',
  sshPort: 22,
  sshUser: 'clawops',
  region: 'us-central1',
  provisionedAt: '2026-05-05T00:00:00.000Z',
}

export const FAKE_OUTPUT_MAP = Object.fromEntries(
  Object.entries(FAKE_BASE_OUTPUTS).map(([k, v]) => [k, { value: v, secret: false }]),
)

export const FAKE_CONN = {
  host: '1.2.3.4',
  port: 22,
  user: 'clawops',
  privateKeyPath: '/tmp/test-id_ed25519',
  knownHostsPath: '/tmp/test-known_hosts',
}

/** Returns a minimal ClawopsContext with a fake Pulumi stack backed by FAKE_BASE_OUTPUTS. */
export function makeFakeContext(): ClawopsContext {
  return {
    config: MINIMAL_CONFIG,
    stackName: 'default',
    adapter: {
      name: 'gcp',
      getConnectionInfo: () => FAKE_CONN,
      normalizeInstanceType: (a: string) => a,
      defaultRegion: () => 'us-central1',
      stateBackendUrl: (b: string) => `gs://${b}`,
      validateConfig: vi.fn().mockResolvedValue({ ok: true, errors: [] }),
      get program() {
        return async () => ({})
      },
    },
    getStack: vi.fn().mockResolvedValue({
      outputs: vi.fn().mockResolvedValue(FAKE_OUTPUT_MAP),
    }),
  } as unknown as ClawopsContext
}

export const FAKE_LOCAL_STATE: LocalState = {
  instanceId: 'local:10.0.0.1',
  publicIp: '10.0.0.1',
  gatewayUrl: 'http://10.0.0.1:18789',
  sshHost: '10.0.0.1',
  sshPort: 22,
  sshUser: 'root',
  region: 'local',
  provisionedAt: '2026-05-06T00:00:00.000Z',
  privateKeyPath: '/tmp/test-id_ed25519',
  knownHostsPath: '/tmp/test-known_hosts',
}

const LOCAL_CONFIG = {
  ...MINIMAL_CONFIG,
  defaults: { stack: 'local-default', provider: 'local' as const },
  stacks: {
    'local-default': {
      provider: 'local' as const,
      stateUrl: 'file://~/.clawops/state',
      credentialsRef: { source: 'file' as const, envVars: [] as string[] },
      localOpts: {
        host: '10.0.0.1',
        sshUser: 'root',
        sshPort: 22,
        sshKeyPath: '/tmp/test-id_ed25519',
      },
    },
  },
}

/** Returns a ClawopsContext for the local provider, bypassing Pulumi entirely. */
export function makeLocalFakeContext(localState: LocalState | null = FAKE_LOCAL_STATE): ClawopsContext {
  return {
    config: LOCAL_CONFIG,
    stackName: 'local-default',
    localState,
    adapter: {
      name: 'local',
      getConnectionInfo: () => FAKE_CONN,
      normalizeInstanceType: () => 'local',
      defaultRegion: () => 'local',
      stateBackendUrl: () => 'file://~/.clawops/state',
      validateConfig: vi.fn().mockResolvedValue({ ok: true, errors: [] }),
      get program() {
        return async () => ({})
      },
    },
    getStack: vi.fn().mockRejectedValue(new Error('local provider does not use Pulumi stacks')),
  } as unknown as ClawopsContext
}
