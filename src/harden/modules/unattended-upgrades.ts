// Unattended upgrades module — security-only automatic updates.

import type { HardeningModule, RemoteExec, CheckResult, ApplyResult } from '../types.js'
import { SENTINEL_DIR } from '../types.js'

const SENTINEL = `${SENTINEL_DIR}/unattended-upgrades.applied`

const AUTO_UPGRADES_CONF = `APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
`

export const unattendedUpgradesModule: HardeningModule = {
  id: 'unattended-upgrades',
  label: 'Automatic security updates',
  defaultOn: true,
  providers: 'all',

  async check(exec: RemoteExec): Promise<CheckResult> {
    const { stdout: sentinel } = await exec(`test -f ${SENTINEL} && echo yes || echo no`)
    if (sentinel.trim() === 'yes') {
      return { status: 'applied', detail: 'unattended-upgrades configured (sentinel present)' }
    }
    const { stdout } = await exec(
      `test -f /etc/apt/apt.conf.d/20auto-upgrades && cat /etc/apt/apt.conf.d/20auto-upgrades || echo ''`,
    )
    if (stdout.includes('Unattended-Upgrade "1"')) {
      return { status: 'applied', detail: 'unattended-upgrades already enabled' }
    }
    return { status: 'missing', detail: 'unattended-upgrades not configured' }
  },

  async apply(exec: RemoteExec): Promise<ApplyResult> {
    const confEscaped = AUTO_UPGRADES_CONF.replace(/'/g, "'\\''")
    const script = [
      `mkdir -p ${SENTINEL_DIR}`,
      'apt-get install -y -q unattended-upgrades',
      `printf '%s' '${confEscaped}' > /etc/apt/apt.conf.d/20auto-upgrades`,
      'systemctl enable --now unattended-upgrades',
      `touch ${SENTINEL}`,
    ].join(' && ')

    const { code, stderr } = await exec(`sudo sh -c '${script.replace(/'/g, "'\\''")}'`)
    if (code !== 0) {
      throw new Error(`unattended-upgrades setup failed (exit ${code}): ${stderr.slice(0, 200)}`)
    }
    return { changed: true, detail: 'unattended-upgrades enabled for security updates' }
  },
}
