// SSH hardening module.
// Hardens sshd_config: disables root login, password auth, limits retries.
// Guards against lockout by verifying the clawops authorized_keys before
// restarting sshd.

import type { HardeningModule, RemoteExec, CheckResult, ApplyResult } from '../types.js'
import { SENTINEL_DIR } from '../types.js'

const SENTINEL = `${SENTINEL_DIR}/ssh.applied`

const SSHD_SETTINGS = [
  'PermitRootLogin no',
  'PasswordAuthentication no',
  'MaxAuthTries 3',
  'LoginGraceTime 30',
]

export const sshModule: HardeningModule = {
  id: 'ssh',
  label: 'SSH hardening',
  defaultOn: true,
  providers: 'all',

  async check(exec: RemoteExec): Promise<CheckResult> {
    const { stdout, code } = await exec(`test -f ${SENTINEL} && echo yes || echo no`)
    if (code === 0 && stdout.trim() === 'yes') {
      return { status: 'applied', detail: 'sshd_config hardened (sentinel present)' }
    }
    // Verify actual sshd_config state even without sentinel
    const { stdout: cfg } = await exec(
      `sshd -T 2>/dev/null | grep -E '^(permitrootlogin|passwordauthentication|maxauthtries|logingracetime)' || true`,
    )
    const lines = cfg.toLowerCase()
    const allApplied =
      lines.includes('permitrootlogin no') &&
      lines.includes('passwordauthentication no') &&
      lines.includes('maxauthtries 3') &&
      lines.includes('logingracetime 30')
    if (allApplied) {
      return { status: 'applied', detail: 'sshd settings already hardened' }
    }
    return { status: 'missing', detail: 'sshd_config has insecure defaults' }
  },

  async apply(exec: RemoteExec): Promise<ApplyResult> {
    // Safety check: confirm the clawops user's authorized_keys contains a key
    // before touching sshd_config — avoids locking ourselves out.
    const { stdout: authKeys } = await exec(
      `cat /home/clawops/.ssh/authorized_keys 2>/dev/null || true`,
    )
    if (!authKeys.trim()) {
      throw new Error(
        'SSH hardening aborted: /home/clawops/.ssh/authorized_keys is empty. ' +
        'Applying PasswordAuthentication=no without a key would lock out access.',
      )
    }

    const settings = SSHD_SETTINGS.map((s) => {
      const [key] = s.split(' ')
      // Remove any existing line for this key, then append the new value
      return `sed -i "/^${key}/Id" /etc/ssh/sshd_config && echo "${s}" >> /etc/ssh/sshd_config`
    }).join(' && ')

    const script = [
      `mkdir -p ${SENTINEL_DIR}`,
      settings,
      'sshd -t',  // validate config before restarting
      'systemctl restart sshd || systemctl restart ssh',
      `touch ${SENTINEL}`,
    ].join(' && ')

    const { code, stderr } = await exec(`sudo sh -c '${script.replace(/'/g, "'\\''")}'`)
    if (code !== 0) {
      throw new Error(`SSH hardening failed (exit ${code}): ${stderr.slice(0, 200)}`)
    }
    return { changed: true, detail: 'sshd_config hardened and sshd restarted' }
  },
}
