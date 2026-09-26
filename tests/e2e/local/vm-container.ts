// A target the local provider's bootstrap can actually run against.
//
// The existing SSH target is `linuxserver/openssh-server`, which has no apt-get and no init.
// The bootstrap's Linux path needs both: it installs Docker from Docker's apt repo, writes
// /etc/systemd/system/openclaw.service and runs `systemctl enable --now`. So the e2e test
// mocked `localBootstrap` out and asserted on the state I/O around it — a suite named after
// the thing it skipped.
//
// This target runs systemd as PID 1 with sshd under it, and deliberately ships without Docker:
// installing Docker is part of what the test exercises. That needs a privileged container with
// the host's cgroup tree, which is why this is opt-in rather than part of `pnpm test`.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GenericContainer, Wait } from 'testcontainers'
import type { StartedTestContainer } from 'testcontainers'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(HERE, '../../integration/fixtures')

/** Committed, and grants access to nothing but a throwaway container. */
export const TEST_KEY_PATH = path.join(FIXTURES, 'test_key')

export const VM_USER = 'clawops-test'

export interface VmTarget {
  host: string
  port: number
  user: string
  keyPath: string
  container: StartedTestContainer
  /** Run a command inside the target, as root. For assertions, not for the code under test. */
  inspect: (command: string) => Promise<{ stdout: string; exitCode: number }>
}

/**
 * Real filesystems for the nested Docker's data directories.
 *
 * Both of these are required, and for two different reasons.
 *
 * Correctness: a container's root is overlayfs, and extracting an image layer there fails on
 * the first whiteout file — `mknod` of a character device returns EPERM on overlayfs, so the
 * OpenClaw image cannot be unpacked at all:
 *
 *   failed to convert whiteout file "usr/local/lib/node_modules/npm/.wh..npmrc":
 *   operation not permitted
 *
 * A volume is backed by a real filesystem, where that mknod succeeds. Note *both* paths:
 * Docker 29 keeps images in the containerd image store under /var/lib/containerd, so mounting
 * only /var/lib/docker — the obvious one — leaves the snapshots on overlayfs and fails
 * identically, several minutes into the pull.
 *
 * Speed: the pull is several gigabytes, and keeping it is the difference between a suite
 * someone runs and one they avoid. The names carry the OpenClaw version, so asking for a
 * different one gets a different cache rather than a stale one. Remove them with
 * `docker volume rm` to force a clean pull.
 */
function cacheVolumesFor(
  openclawVersion: string,
): { source: string; target: string; mode: 'rw' }[] {
  // A bind mount whose source is not a path is a named volume — testcontainers passes the
  // source straight through to Docker's Binds.
  const tag = openclawVersion.replace(/[^\w.-]/g, '-')
  return [
    { source: `clawops-e2e-docker-${tag}`, target: '/var/lib/docker', mode: 'rw' },
    { source: `clawops-e2e-containerd-${tag}`, target: '/var/lib/containerd', mode: 'rw' },
  ]
}

export async function startVmTarget(openclawVersion: string): Promise<VmTarget> {
  const authorizedKey = readFileSync(path.join(FIXTURES, 'test_key.pub'), 'utf-8').trim()

  const image = await GenericContainer.fromDockerfile(path.join(HERE, 'vm'))
    .withBuildArgs({ AUTHORIZED_KEY: authorizedKey })
    .build('clawops-vm-target:test', { deleteOnExit: false })

  const container = await image
    // systemd needs to manage cgroups and dockerd needs to create them; /run and /run/lock are
    // tmpfs because systemd writes its runtime state there and the image ships neither.
    .withPrivilegedMode()
    .withBindMounts([
      { source: '/sys/fs/cgroup', target: '/sys/fs/cgroup', mode: 'rw' },
      ...cacheVolumesFor(openclawVersion),
    ])
    .withTmpFs({ '/run': '', '/run/lock': '' })
    .withExposedPorts(22)
    // Listening is not the same as ready: sshd answers before systemd has finished bringing
    // the unit up, and a connection in that window fails in a way that reads like a bad key.
    .withWaitStrategy(Wait.forSuccessfulCommand('systemctl is-active ssh'))
    .withStartupTimeout(120_000)
    .start()

  return {
    host: container.getHost(),
    port: container.getMappedPort(22),
    user: VM_USER,
    keyPath: TEST_KEY_PATH,
    container,
    inspect: async (command: string) => {
      const result = await container.exec(['bash', '-lc', command])
      return { stdout: result.output, exitCode: result.exitCode }
    },
  }
}

export async function stopVmTarget(target: VmTarget): Promise<void> {
  await target.container.stop({ remove: true })
}
