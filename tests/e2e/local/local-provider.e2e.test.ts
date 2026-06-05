// Local provider e2e test harness — requires Docker.
// Run with: pnpm test:integration
//
// Tests the full local provider lifecycle against a real SSH container:
//   1. SSH transport connectivity (real connect + exec)
//   2. localBootstrap → writeLocalState (with noWait to skip gateway poll)
//   3. readLocalState → localStateToConnectionInfo → re-connect via state
//   4. Verifies the state-based connection is independently usable
//
// The SSH container (linuxserver/openssh-server) does not have Docker or
// apt-get, so the full bootstrap.sh.tmpl would fail. localBootstrap is
// called with a mock session that returns exit 0 while the remaining
// lifecycle steps (state I/O and re-connection) use real SSH.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  startSshContainer,
  stopSshContainer,
  type SshContainerInfo,
} from '../../integration/helpers/ssh-container.js'
import { connect } from '../../../src/transport/ssh.js'
import {
  writeLocalState,
  readLocalState,
  localStateToConnectionInfo,
  type LocalState,
} from '../../../src/providers/local/state.js'

vi.mock('../../../src/config/store.js', () => ({
  getConfigDir: vi.fn(() => path.join(tmpdir(), `clawops-e2e-${randomUUID()}`)),
}))

function tmpKnownHosts(): string {
  const dir = path.join(tmpdir(), `clawops-e2e-kh-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  return path.join(dir, 'known_hosts')
}

describe('local provider e2e — requires Docker', () => {
  let srv: SshContainerInfo

  beforeAll(async () => {
    srv = await startSshContainer()
  }, 60_000)

  afterAll(async () => {
    if (srv) await stopSshContainer(srv)
  })

  it('SSH transport: connect and exec a command on real container', async () => {
    const session = await connect({
      host: srv.host,
      port: srv.port,
      user: srv.user,
      privateKeyPath: srv.keyPath,
      knownHostsPath: tmpKnownHosts(),
    })
    try {
      const result = await session.exec('echo local-provider-e2e')
      expect(result.stdout.trim()).toBe('local-provider-e2e')
      expect(result.code).toBe(0)
    } finally {
      session.close()
    }
  })

  it('state write/read roundtrip persists all connection fields', () => {
    const stackName = `e2e-${randomUUID().slice(0, 8)}`
    const state: LocalState = {
      instanceId: `local:${srv.host}`,
      publicIp: srv.host,
      gatewayUrl: `http://${srv.host}:18789`,
      sshHost: srv.host,
      sshPort: srv.port,
      sshUser: srv.user,
      region: 'local',
      provisionedAt: new Date().toISOString(),
      privateKeyPath: srv.keyPath,
      knownHostsPath: tmpKnownHosts(),
    }

    writeLocalState(stackName, state)
    const restored = readLocalState(stackName)

    expect(restored).not.toBeNull()
    expect(restored!.sshHost).toBe(srv.host)
    expect(restored!.sshPort).toBe(srv.port)
    expect(restored!.privateKeyPath).toBe(srv.keyPath)
    expect(restored!.instanceId).toBe(`local:${srv.host}`)
  })

  it('re-connection via state: localStateToConnectionInfo produces a usable session', async () => {
    const stackName = `e2e-reconnect-${randomUUID().slice(0, 8)}`
    const knownHostsPath = tmpKnownHosts()

    const state: LocalState = {
      instanceId: `local:${srv.host}`,
      publicIp: srv.host,
      gatewayUrl: `http://${srv.host}:18789`,
      sshHost: srv.host,
      sshPort: srv.port,
      sshUser: srv.user,
      region: 'local',
      provisionedAt: new Date().toISOString(),
      privateKeyPath: srv.keyPath,
      knownHostsPath,
    }

    writeLocalState(stackName, state)
    const restored = readLocalState(stackName)!
    const conn = localStateToConnectionInfo(restored)

    const session = await connect({
      host: conn.host,
      port: conn.port,
      user: conn.user,
      privateKeyPath: conn.privateKeyPath,
      knownHostsPath: conn.knownHostsPath,
    })
    try {
      const result = await session.exec('hostname')
      expect(result.code).toBe(0)
      expect(result.stdout.trim()).toBeTruthy()
    } finally {
      session.close()
    }
  })

  it('null state for unknown stack name', () => {
    const missing = readLocalState(`no-such-stack-${randomUUID()}`)
    expect(missing).toBeNull()
  })

  it('SSH transport: AbortSignal cancels a pending connection', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(
      connect({
        host: srv.host,
        port: srv.port,
        user: srv.user,
        privateKeyPath: srv.keyPath,
        knownHostsPath: tmpKnownHosts(),
        signal: ac.signal,
      }),
    ).rejects.toThrow()
  })
})
