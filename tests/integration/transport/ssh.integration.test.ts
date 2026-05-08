// Real SSH integration tests — requires Docker.
// Uses linuxserver/openssh-server via testcontainers.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { tmpdir } from 'node:os'
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { connect } from '../../../src/transport/ssh.js'
import {
  startSshContainer,
  stopSshContainer,
  TEST_KEY_PATH,
  type SshContainerInfo,
} from '../helpers/ssh-container.js'

function tmpKnownHosts(): string {
  const dir = path.join(tmpdir(), `clawops-test-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  return path.join(dir, 'known_hosts')
}

describe('SSH integration — happy path', () => {
  let srv: SshContainerInfo

  beforeAll(async () => {
    srv = await startSshContainer()
  }, 60_000)

  afterAll(async () => {
    if (srv) await stopSshContainer(srv)
  })

  it('connects and execs a command', async () => {
    const session = await connect({
      host: srv.host,
      port: srv.port,
      user: srv.user,
      privateKeyPath: srv.keyPath,
      knownHostsPath: tmpKnownHosts(),
    })

    try {
      const result = await session.exec('echo clawops')
      expect(result.stdout.trim()).toBe('clawops')
      expect(result.code).toBe(0)
    } finally {
      session.close()
    }
  })

  it('TOFU: second connection with same known_hosts file succeeds', async () => {
    const knownHosts = tmpKnownHosts()

    const session1 = await connect({
      host: srv.host,
      port: srv.port,
      user: srv.user,
      privateKeyPath: srv.keyPath,
      knownHostsPath: knownHosts,
    })
    session1.close()

    // Second connect using same known_hosts — key already recorded
    const session2 = await connect({
      host: srv.host,
      port: srv.port,
      user: srv.user,
      privateKeyPath: srv.keyPath,
      knownHostsPath: knownHosts,
    })
    const result = await session2.exec('echo tofu-ok')
    session2.close()
    expect(result.stdout.trim()).toBe('tofu-ok')
  })

  it('host key mismatch: rejects connection when known_hosts has wrong key', async () => {
    const knownHosts = tmpKnownHosts()
    const hostEntry = `[${srv.host}]:${srv.port}`
    // Write a deliberately wrong key fingerprint
    writeFileSync(knownHosts, `${hostEntry} deadbeefdeadbeef\n`, 'utf-8')

    await expect(
      connect({
        host: srv.host,
        port: srv.port,
        user: srv.user,
        privateKeyPath: srv.keyPath,
        knownHostsPath: knownHosts,
      }),
    ).rejects.toThrow()
  })

  it('mid-exec abort cancels the operation', async () => {
    const session = await connect({
      host: srv.host,
      port: srv.port,
      user: srv.user,
      privateKeyPath: srv.keyPath,
      knownHostsPath: tmpKnownHosts(),
    })

    const controller = new AbortController()

    try {
      const execPromise = session.exec('sleep 10', controller.signal)
      setTimeout(() => controller.abort(), 50)
      await expect(execPromise).rejects.toThrow(/aborted/i)
    } finally {
      session.close()
    }
  })

  it('tunnel EADDRINUSE: second tunnel on same port rejects', async () => {
    const session = await connect({
      host: srv.host,
      port: srv.port,
      user: srv.user,
      privateKeyPath: srv.keyPath,
      knownHostsPath: tmpKnownHosts(),
    })

    const LOCAL_PORT = 19876

    try {
      const t1 = await session.tunnel(LOCAL_PORT, '127.0.0.1', 22)
      try {
        await expect(
          session.tunnel(LOCAL_PORT, '127.0.0.1', 22),
        ).rejects.toThrow(/already in use/i)
      } finally {
        t1.close()
      }
    } finally {
      session.close()
    }
  })
})

describe('SSH integration — error paths (no container needed)', () => {
  it('ECONNREFUSED: connect to closed port rejects with NetworkError', async () => {
    await expect(
      connect({
        host: '127.0.0.1',
        port: 1,
        user: 'nobody',
        privateKeyPath: TEST_KEY_PATH,
        knownHostsPath: tmpKnownHosts(),
      }),
    ).rejects.toThrow(/connection failed|ECONNREFUSED/i)
  })

  it('pre-aborted signal rejects immediately', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      connect({
        host: '127.0.0.1',
        port: 22,
        user: 'nobody',
        privateKeyPath: TEST_KEY_PATH,
        knownHostsPath: tmpKnownHosts(),
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted/i)
  })
})

describe('SSH integration — auth failure', () => {
  let srv: SshContainerInfo

  beforeAll(async () => {
    srv = await startSshContainer()
  }, 60_000)

  afterAll(async () => {
    if (srv) await stopSshContainer(srv)
  })

  it('auth failure: wrong key is rejected', async () => {
    // Generate a fresh key in a tmp dir that the container doesn't know about
    const wrongKeyDir = path.join(tmpdir(), `clawops-wrong-${randomUUID()}`)
    mkdirSync(wrongKeyDir, { recursive: true })
    const wrongKeyPath = path.join(wrongKeyDir, 'wrong_key')

    // Write a random-content file as a "wrong key" — ssh2 will reject during connect
    writeFileSync(wrongKeyPath, '-----BEGIN OPENSSH PRIVATE KEY-----\ninvalid\n-----END OPENSSH PRIVATE KEY-----\n')

    await expect(
      connect({
        host: srv.host,
        port: srv.port,
        user: srv.user,
        privateKeyPath: wrongKeyPath,
        knownHostsPath: tmpKnownHosts(),
      }),
    ).rejects.toThrow()
  })
})
