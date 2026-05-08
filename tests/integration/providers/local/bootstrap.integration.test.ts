// Real bootstrap integration tests — requires Docker.
// Runs localBootstrap() against a real linuxserver/openssh-server container.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  startSshContainer,
  stopSshContainer,
  type SshContainerInfo,
} from '../../helpers/ssh-container.js'

// localBootstrap writes state to ~/.clawops/; mock writeLocalState to avoid side effects
vi.mock('../../../../src/providers/local/state.js', () => ({
  writeLocalState: vi.fn(),
  readLocalState: vi.fn(() => null),
}))

function tmpKnownHosts(): string {
  const dir = path.join(tmpdir(), `clawops-bootstrap-test-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  return path.join(dir, 'known_hosts')
}

describe('localBootstrap integration', () => {
  let srv: SshContainerInfo

  beforeAll(async () => {
    srv = await startSshContainer()
  }, 60_000)

  afterAll(async () => {
    if (srv) await stopSshContainer(srv)
  })

  it('happy path: runs script and returns LocalState', async () => {
    const { localBootstrap } = await import('../../../../src/providers/local/bootstrap.js')

    const state = await localBootstrap({
      host: srv.host,
      port: srv.port,
      user: srv.user,
      privateKeyPath: srv.keyPath,
      knownHostsPath: tmpKnownHosts(),
      openclawVersion: 'stable',
      stackName: 'integration-test',
      noWait: true,
    })

    expect(state.publicIp).toBe(srv.host)
    expect(state.sshPort).toBe(srv.port)
    expect(state.gatewayUrl).toContain(':18789')
    expect(state.provisionedAt).toBeTruthy()
  })

  it('noWait=true skips health check and returns state immediately', async () => {
    const { localBootstrap } = await import('../../../../src/providers/local/bootstrap.js')

    const start = Date.now()
    const state = await localBootstrap({
      host: srv.host,
      port: srv.port,
      user: srv.user,
      privateKeyPath: srv.keyPath,
      knownHostsPath: tmpKnownHosts(),
      openclawVersion: 'stable',
      stackName: 'integration-test-nowait',
      noWait: true,
    })

    expect(Date.now() - start).toBeLessThan(15_000)
    expect(state).toBeDefined()
  })

  it('AbortSignal aborts during exec', async () => {
    const { localBootstrap } = await import('../../../../src/providers/local/bootstrap.js')
    const controller = new AbortController()
    controller.abort()

    await expect(
      localBootstrap({
        host: srv.host,
        port: srv.port,
        user: srv.user,
        privateKeyPath: srv.keyPath,
        knownHostsPath: tmpKnownHosts(),
        openclawVersion: 'stable',
        stackName: 'integration-test-abort',
        noWait: true,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted/i)
  })
})
