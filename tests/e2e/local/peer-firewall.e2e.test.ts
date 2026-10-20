// The fleet firewall table on a real systemd host (ADR 0015 §4, SP-16).
//
// The unit tests check what install writes and how the check reads a listing. Only a real host
// answers whether this kernel's nftables loads the file, whether `nft list` prints what the check
// expects, whether nftables is installed where the image lacks it, and whether the unit puts the
// table back after a reboot before docker.service starts.
//
// docker.service here is a stand-in that records when it started: the ordering is systemd's to
// keep, not Docker's, and SP-16 measured the rules against real Docker on real VMs. A restart of
// the target is the reboot. It starts with no netfilter state and runs a full systemd boot.
//
// Opt-in: `pnpm test:e2e:local`. No OpenClaw image is pulled.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { connect, type SshSession } from '../../../src/transport/ssh.js'
import { installPeerFirewall, removePeerFirewall } from '../../../src/hostagent/install.js'
import { checkPeerTable, PEER_TABLE_LIST_CMD } from '../../../src/hostagent/peer-firewall.js'
import { fleetStatus } from '../../../src/hostagent/fleet-status.js'
import { startVmTarget, stopVmTarget, TEST_KEY_PATH, VM_USER, type VmTarget } from './vm-container.js'

const enabled = process.env['CLAWOPS_E2E_LOCAL'] === '1'
// Names this suite's cache volumes, apart from the OpenClaw suites' multi-gigabyte ones.
const VOLUME_TAG = 'peer-fw'

const STAND_IN_DOCKER = `[Unit]
Description=stand-in for docker.service: records when it started

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/true

[Install]
WantedBy=multi-user.target
`

describe.skipIf(!enabled)('the fleet firewall table on a real host', () => {
  let vm: VmTarget
  let session: SshSession
  let uid: number
  const knownHosts = path.join(mkdtempSync(path.join(tmpdir(), 'clawops-e2e-peerfw-')), 'known_hosts')

  async function open(): Promise<SshSession> {
    return connect({ host: vm.host, port: vm.container.getMappedPort(22), user: VM_USER, privateKeyPath: TEST_KEY_PATH, knownHostsPath: knownHosts })
  }

  async function listed(): Promise<string> {
    return (await vm.inspect(PEER_TABLE_LIST_CMD)).stdout
  }

  /** systemd's monotonic timestamp for a unit property, in microseconds since boot. */
  async function stamp(unit: string, prop: string): Promise<number> {
    return Number((await vm.inspect(`systemctl show ${unit} -p ${prop} --value`)).stdout.trim())
  }

  beforeAll(async () => {
    vm = await startVmTarget(VOLUME_TAG)
    const b64 = Buffer.from(STAND_IN_DOCKER).toString('base64')
    const r = await vm.inspect(`echo ${b64} | base64 -d > /etc/systemd/system/docker.service && systemctl daemon-reload && systemctl enable --now docker.service`)
    expect(r.exitCode, r.stdout).toBe(0)
    session = await open()
  }, 300_000)

  afterAll(async () => {
    session?.close()
    if (vm) await stopVmTarget(vm)
    spawnSync('docker', ['volume', 'rm', `clawops-e2e-docker-${VOLUME_TAG}`, `clawops-e2e-containerd-${VOLUME_TAG}`])
  })

  it('installs nftables, which the image lacks, and loads exactly the table the check expects', async () => {
    expect((await vm.inspect('command -v nft')).exitCode).not.toBe(0)
    const fw = await installPeerFirewall(session)
    expect(fw, JSON.stringify(fw)).toMatchObject({ ok: true })
    if (!fw.ok) return
    uid = fw.uid
    expect((await vm.inspect('id -u clawops-peer')).stdout.trim()).toBe(String(uid))
    // The listing comes from this kernel's nft, not from the file install wrote.
    expect(checkPeerTable(await listed(), uid)).toEqual({ ok: true })
  }, 300_000)

  it('is back after a reboot, loaded before docker.service started', async () => {
    session.close()
    const before = Number((await vm.inspect('ps -o etimes= -p 1')).stdout.trim())
    await vm.container.restart()
    for (let i = 0; i < 60; i++) {
      const s = (await vm.inspect('systemctl is-system-running')).stdout.trim()
      if (s === 'running' || s === 'degraded') break
      await new Promise((r) => setTimeout(r, 1000))
    }
    // A new PID 1, younger than the one before: a boot, not a reconnect.
    const after = Number((await vm.inspect('ps -o etimes= -p 1')).stdout.trim())
    expect(after).toBeLessThan(before)
    expect((await vm.inspect('nft list tables')).stdout).toContain('clawops_peer')
    expect((await vm.inspect('systemctl is-active clawops-peer-fw.service')).stdout.trim()).toBe('active')
    expect(checkPeerTable(await listed(), uid)).toEqual({ ok: true })

    const tableLoaded = await stamp('clawops-peer-fw.service', 'ExecMainExitTimestampMonotonic')
    const dockerStarted = await stamp('docker.service', 'ExecMainStartTimestampMonotonic')
    expect(tableLoaded).toBeGreaterThan(0)
    expect(dockerStarted).toBeGreaterThanOrEqual(tableLoaded)
    session = await open()
  }, 300_000)

  it('can be installed again without a second table or a gap', async () => {
    const fw = await installPeerFirewall(session)
    expect(fw).toEqual({ ok: true, uid })
    expect((await vm.inspect('nft list tables')).stdout.match(/clawops_peer/g)).toHaveLength(1)
  }, 120_000)

  // `clawops fleet status` reads this host with the same script; here against a real systemd and
  // a real nft, whose output the unit tests only imitate. There is no host agent unit and no
  // tailscaled on this target, so those two are what it reports.
  it('is read by fleet status as install left it', async () => {
    const agentJson = JSON.stringify({
      version: 1, stack: 'e2e', provider: 'local', agentId: 'ops', operators: ['telegram:1'], allow: [], strict: true,
      fleet: { serves: 'tag:clawops-agent', peers: [], peerUid: uid }, installedAt: new Date().toISOString(),
    })
    const b64 = Buffer.from(agentJson).toString('base64')
    expect((await vm.inspect(`echo ${b64} | base64 -d > /etc/clawops-agent/agent.json`)).exitCode).toBe(0)
    try {
      const status = await fleetStatus(['e2e'], { open: async () => ({ session, release: () => {} }) })
      const [h] = status.hosts
      expect(h, JSON.stringify(h)).toMatchObject({ state: 'problems', service: 'inactive', fleet: { serves: 'tag:clawops-agent', firewall: 'ok' } })
      expect(h!.problems).toEqual([
        expect.stringMatching(/service is inactive/),
        expect.stringMatching(/tailscaled did not answer/),
      ])
    } finally {
      await vm.inspect('rm -f /etc/clawops-agent/agent.json')
    }
  }, 120_000)

  it('fails the check once someone puts a rule ahead of the drops', async () => {
    await vm.inspect('nft insert rule inet clawops_peer pre iifname "docker0" accept')
    expect(checkPeerTable(await listed(), uid)).toEqual({ ok: false, reason: expect.stringMatching(/pre chain/) })
    // Installing again restores it.
    expect(await installPeerFirewall(session)).toEqual({ ok: true, uid })
    expect(checkPeerTable(await listed(), uid)).toEqual({ ok: true })
  }, 120_000)

  it('is removed with its unit, its files and its user', async () => {
    expect(await removePeerFirewall(session)).toEqual({ removed: true })
    expect((await vm.inspect(PEER_TABLE_LIST_CMD)).exitCode).not.toBe(0)
    expect((await vm.inspect('test -e /etc/systemd/system/clawops-peer-fw.service || test -e /etc/clawops-agent/peer-fw.nft || id clawops-peer')).exitCode).not.toBe(0)
    expect(await removePeerFirewall(session)).toEqual({ removed: false })
  }, 120_000)
})
