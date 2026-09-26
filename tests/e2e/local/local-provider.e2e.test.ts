// The local provider's bootstrap, run for real.
//
// What this file used to do: mock `localBootstrap` to return exit 0 and then assert on the
// state I/O around it. Its own header said why — the SSH target had no apt-get and no init, so
// the script could not run — which made this a suite named after the step it skipped. Every
// claim the bootstrap makes (Docker installed, unit written and enabled, state directory owned
// by the uid the container runs as, token generated once) was unverified, and two of those have
// since been the cause of a live incident.
//
// It now runs against a systemd target (see ./vm-container.ts) and asserts the result on the
// host itself. That needs a privileged container, several gigabytes of image and a few minutes,
// so it is opt-in: `pnpm test:e2e:local`, or CLAWOPS_E2E_LOCAL=1 with `pnpm test:integration`.
//
// Verified by mutation rather than by being green, because green is what the old version was.
// The mutations are on the template, not in scripts/dev/mutation-check.mjs, which must keep
// running without Docker:
//   chown -R 1000:1000 → 1001:1001   kills 4 tests; the gateway restart-loops at 'activating'
//   the token guard → `if true`      kills exactly the rotation test, and nothing else

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startVmTarget, stopVmTarget, type VmTarget } from './vm-container.js'
import { localBootstrap } from '../../../src/providers/local/bootstrap.js'
import { GATEWAY_PORT } from '../../../src/openclaw/runtime.js'
import type { LocalState } from '../../../src/providers/local/state.js'

const OPENCLAW_VERSION = process.env['CLAWOPS_E2E_OPENCLAW_VERSION'] ?? '2026.9.2'
const STATE_DIR = '/var/lib/clawops/openclaw'
const ENV_FILE = '/home/clawops/openclaw.env'
const STACK = 'e2e-local'

// Opt-in. Left on by default this would add several minutes and a privileged container to
// `pnpm test`, which is the surest way to get a suite disabled rather than fixed.
const enabled = process.env['CLAWOPS_E2E_LOCAL'] === '1'

describe.skipIf(!enabled)('local provider bootstrap against a systemd target', () => {
  let vm: VmTarget
  let knownHostsPath: string
  let state: LocalState
  let tokenAfterFirstRun: string

  beforeAll(async () => {
    vm = await startVmTarget(OPENCLAW_VERSION)
    knownHostsPath = path.join(mkdtempSync(path.join(tmpdir(), 'clawops-e2e-kh-')), 'known_hosts')
  }, 300_000)

  afterAll(async () => {
    if (vm) await stopVmTarget(vm)
  })

  it('starts from a host that has no Docker', async () => {
    // If the image ever ships Docker, the install branch below stops being exercised and this
    // suite quietly becomes a test of a no-op.
    const probe = await vm.inspect('command -v docker')
    expect(probe.exitCode).not.toBe(0)
  })

  it('installs Docker, starts the gateway and waits for it to answer', async () => {
    state = await localBootstrap({
      host: vm.host,
      port: vm.port,
      user: vm.user,
      privateKeyPath: vm.keyPath,
      knownHostsPath,
      openclawVersion: OPENCLAW_VERSION,
      stackName: STACK,
    })

    // Not `toBeDefined`: the returned state is what every later command connects with, and a
    // field carrying the wrong value fails at a distance.
    expect(state.sshHost).toBe(vm.host)
    expect(state.sshPort).toBe(vm.port)
    expect(state.sshUser).toBe(vm.user)
    expect(state.gatewayUrl).toBe(`http://${vm.host}:${GATEWAY_PORT}`)
    expect(Date.parse(state.provisionedAt)).not.toBeNaN()

    const docker = await vm.inspect('docker --version')
    expect(docker.exitCode).toBe(0)
  }, 900_000)

  it('runs the gateway under systemd, not as a loose container', async () => {
    const enabledUnit = await vm.inspect('systemctl is-enabled openclaw')
    expect(enabledUnit.stdout.trim()).toBe('enabled')

    const active = await vm.inspect('systemctl is-active openclaw')
    expect(active.stdout.trim()).toBe('active')

    const container = await vm.inspect(
      'docker ps --filter name=openclaw --format "{{.Names}}"',
    )
    expect(container.stdout.trim()).toBe('openclaw')
  })

  it('leaves the state directory owned by the uid the container runs as', async () => {
    // 1000:1000 numerically, never clawops:clawops. useradd hands out 1001 on Ubuntu 24.04
    // because the `ubuntu` user already holds 1000, and a 1001-owned state directory makes the
    // gateway exit 1 on its own SQLite WAL.
    const owner = await vm.inspect(`stat -c %u:%g ${STATE_DIR}`)
    expect(owner.stdout.trim()).toBe('1000:1000')

    const contents = await vm.inspect(
      `find ${STATE_DIR} -mindepth 1 -printf '%U\\n' | sort -u | tr '\\n' ' '`,
    )
    expect(contents.stdout.trim()).toBe('1000')
  })

  it('writes the gateway config with the port the container publishes', async () => {
    const raw = await vm.inspect(`cat ${STATE_DIR}/openclaw.json`)
    expect(raw.exitCode).toBe(0)
    const config = JSON.parse(raw.stdout) as {
      gateway: { mode: string; port: number; auth: { mode: string } }
    }
    // A container that publishes one port while the gateway listens on another starts, looks
    // healthy to Docker, and answers nothing.
    expect(config.gateway.port).toBe(GATEWAY_PORT)
    expect(config.gateway.mode).toBe('local')
    expect(config.gateway.auth.mode).toBe('token')
  })

  it('writes a gateway token only its owner can read', async () => {
    const mode = await vm.inspect(`stat -c %a ${ENV_FILE}`)
    expect(mode.stdout.trim()).toBe('600')

    const contents = await vm.inspect(`cat ${ENV_FILE}`)
    const match = /^OPENCLAW_GATEWAY_TOKEN=([0-9a-f]{64})$/m.exec(contents.stdout.trim())
    expect(match).not.toBeNull()
    tokenAfterFirstRun = match![1]
  })

  it('does not rotate the token when it runs again', async () => {
    // The script says the token is "generated once and reused on re-runs so restarts don't
    // rotate it". Re-running is the normal case — every `clawops up` does it — and a rotated
    // token silently locks out every client holding the old one.
    await localBootstrap({
      host: vm.host,
      port: vm.port,
      user: vm.user,
      privateKeyPath: vm.keyPath,
      knownHostsPath,
      openclawVersion: OPENCLAW_VERSION,
      stackName: STACK,
    })

    const contents = await vm.inspect(`cat ${ENV_FILE}`)
    expect(contents.stdout.trim()).toBe(`OPENCLAW_GATEWAY_TOKEN=${tokenAfterFirstRun}`)

    const active = await vm.inspect('systemctl is-active openclaw')
    expect(active.stdout.trim()).toBe('active')
  }, 600_000)
})
