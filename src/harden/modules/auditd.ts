// auditd module (opt-in) — kernel audit logging for privileged commands.

import type { HardeningModule, RemoteExec, CheckResult, ApplyResult } from '../types.js'
import { SENTINEL_DIR } from '../types.js'

const SENTINEL = `${SENTINEL_DIR}/auditd.applied`

// Minimal CIS-aligned rules for privileged commands and clawops files.
const AUDIT_RULES = `-a always,exit -F arch=b64 -S execve -F euid=0 -k privileged
-a always,exit -F arch=b64 -S open,openat -F dir=/etc/ssh -F perm=wa -k sshd_config
-a always,exit -F arch=b64 -S open,openat -F dir=/etc/clawops -F perm=wa -k clawops_config
-e 2
`

export const auditdModule: HardeningModule = {
  id: 'auditd',
  label: 'auditd (kernel audit logging)',
  defaultOn: false,
  providers: 'all',

  async check(exec: RemoteExec): Promise<CheckResult> {
    const { stdout: sentinel } = await exec(`test -f ${SENTINEL} && echo yes || echo no`)
    if (sentinel.trim() === 'yes') {
      return { status: 'applied', detail: 'auditd configured (sentinel present)' }
    }
    const { stdout: active } = await exec(
      `systemctl is-active auditd 2>/dev/null || echo inactive`,
    )
    if (active.trim() === 'active') {
      return { status: 'applied', detail: 'auditd already running' }
    }
    return { status: 'missing', detail: 'auditd not installed or not running' }
  },

  async apply(exec: RemoteExec): Promise<ApplyResult> {
    const rulesEscaped = AUDIT_RULES.replace(/'/g, "'\\''")
    const script = [
      `mkdir -p ${SENTINEL_DIR}`,
      'apt-get install -y -q auditd',
      `printf '%s' '${rulesEscaped}' > /etc/audit/rules.d/clawops.rules`,
      'augenrules --load || auditctl -R /etc/audit/rules.d/clawops.rules',
      'systemctl enable --now auditd',
      `touch ${SENTINEL}`,
    ].join(' && ')

    const { code, stderr } = await exec(`sudo sh -c '${script.replace(/'/g, "'\\''")}'`)
    if (code !== 0) {
      throw new Error(`auditd setup failed (exit ${code}): ${stderr.slice(0, 200)}`)
    }
    return { changed: true, detail: 'auditd installed with CIS-aligned rules' }
  },
}
