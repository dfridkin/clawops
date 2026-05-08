// Docker-based SSH test server using testcontainers + linuxserver/openssh-server.
// Both test_key and test_key.pub are committed — these keys have no real access.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GenericContainer, Wait } from 'testcontainers'
import type { StartedTestContainer } from 'testcontainers'

const FIXTURES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures',
)

export const TEST_KEY_PATH = path.join(FIXTURES_DIR, 'test_key')
export const TEST_KEY_PUB_PATH = path.join(FIXTURES_DIR, 'test_key.pub')

export interface SshContainerInfo {
  host: string
  port: number
  user: string
  keyPath: string
  container: StartedTestContainer
}

export async function startSshContainer(): Promise<SshContainerInfo> {
  const pubKey = readFileSync(TEST_KEY_PUB_PATH, 'utf-8').trim()

  const container = await new GenericContainer('lscr.io/linuxserver/openssh-server:latest')
    .withEnvironment({
      PUID: '1000',
      PGID: '1000',
      USER_NAME: 'testuser',
      PUBLIC_KEY: pubKey,
    })
    .withExposedPorts(2222)
    .withWaitStrategy(Wait.forListeningPorts())
    .start()

  const host = container.getHost()
  const port = container.getMappedPort(2222)

  return {
    host,
    port,
    user: 'testuser',
    keyPath: TEST_KEY_PATH,
    container,
  }
}

export async function stopSshContainer(info: SshContainerInfo): Promise<void> {
  await info.container.stop({ remove: true })
}
