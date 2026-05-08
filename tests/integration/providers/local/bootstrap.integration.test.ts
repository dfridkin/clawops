// Bootstrap integration tests.
// Real SSH connection + exec behavior is covered by ssh.integration.test.ts.
// These tests mock acquireSession to inject controlled exec results, keeping
// the focus on localBootstrap()'s own logic: state construction, writeLocalState,
// noWait bypass, and AbortSignal propagation.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { FakeSshSession } from '../../../helpers/ssh.js'
import { TEST_KEY_PATH } from '../../helpers/ssh-container.js'

vi.mock('../../../../src/providers/local/state.js', () => ({
  writeLocalState: vi.fn(),
  readLocalState: vi.fn(() => null),
}))

vi.mock('../../../../src/transport/pool.js', () => ({
  acquireSession: vi.fn(),
  drainPool: vi.fn(),
}))

function tmpKnownHosts(): string {
  const dir = path.join(tmpdir(), `clawops-bootstrap-test-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  return path.join(dir, 'known_hosts')
}

const BASE_OPTS = {
  host: '10.0.0.1',
  port: 22,
  user: 'testuser',
  privateKeyPath: TEST_KEY_PATH,
  knownHostsPath: tmpKnownHosts(),
  openclawVersion: 'stable',
  stackName: 'integration-test',
  noWait: true,
}

async function getMockAcquireSession() {
  const { acquireSession } = await import('../../../../src/transport/pool.js')
  return vi.mocked(acquireSession)
}

beforeEach(async () => {
  vi.clearAllMocks()
})

describe('localBootstrap integration', () => {
  it('happy path: runs script and returns LocalState', async () => {
    const session = new FakeSshSession()
    session.onExec(() => ({ stdout: '', stderr: '', code: 0 }))
    const acquireSession = await getMockAcquireSession()
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const { localBootstrap } = await import('../../../../src/providers/local/bootstrap.js')
    const state = await localBootstrap(BASE_OPTS)

    expect(state.publicIp).toBe(BASE_OPTS.host)
    expect(state.sshPort).toBe(BASE_OPTS.port)
    expect(state.gatewayUrl).toContain(':18789')
    expect(state.provisionedAt).toBeTruthy()
  })

  it('noWait=true returns immediately without calling waitForGateway', async () => {
    const session = new FakeSshSession()
    session.onExec(() => ({ stdout: '', stderr: '', code: 0 }))
    const acquireSession = await getMockAcquireSession()
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const { localBootstrap } = await import('../../../../src/providers/local/bootstrap.js')
    await localBootstrap(BASE_OPTS)

    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('non-zero exit code throws ProviderError', async () => {
    const session = new FakeSshSession()
    session.onExec(() => ({ stdout: '', stderr: 'apt-get: command not found', code: 127 }))
    const acquireSession = await getMockAcquireSession()
    acquireSession.mockResolvedValue({ session, release: vi.fn() })

    const { localBootstrap } = await import('../../../../src/providers/local/bootstrap.js')
    await expect(localBootstrap(BASE_OPTS)).rejects.toThrow(/exit 127/)
  })

  it('propagates abort signal — acquireSession rejects with NetworkError', async () => {
    const acquireSession = await getMockAcquireSession()
    const controller = new AbortController()
    controller.abort()
    // Simulate what the real pool/connect does when signal is already aborted
    acquireSession.mockRejectedValue(new Error('Connection aborted'))

    const { localBootstrap } = await import('../../../../src/providers/local/bootstrap.js')
    await expect(
      localBootstrap({ ...BASE_OPTS, signal: controller.signal }),
    ).rejects.toThrow(/aborted/i)
  })
})
