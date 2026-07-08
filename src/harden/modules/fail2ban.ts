// Fail2ban module — SSH jail: 5 failures → 10-minute ban.

import type { HardeningModule, RemoteExec, CheckResult, ApplyResult } from '../types.js'
import { SENTINEL_DIR } from '../types.js'

const SENTINEL = `${SENTINEL_DIR}/fail2ban.applied`

const JAIL_CONF = `[sshd]
enabled  = true
port     = ssh
maxretry = 5
bantime  = 600
findtime = 600
`

export const fail2banModule: HardeningModule = {
  id: 'fail2ban',
  label: 'Fail2ban (SSH jail)',
  defaultOn: true,
  providers: 'all',

  async check(exec: RemoteExec): Promise<CheckResult> {
    const { stdout: sentinel } = await exec(`test -f ${SENTINEL} && echo yes || echo no`)
    if (sentinel.trim() === 'yes') {
      return { status: 'applied', detail: 'fail2ban configured (sentinel present)' }
    }
    const { stdout: active } = await exec(
      `systemctl is-active fail2ban 2>/dev/null || echo inactive`,
    )
    if (active.trim() === 'active') {
      return { status: 'applied', detail: 'fail2ban already running' }
    }
    const { stdout: installed } = await exec(
      `dpkg -l fail2ban 2>/dev/null | grep -c '^ii' || echo 0`,
    )
    if (parseInt(installed.trim(), 10) > 0) {
      return { status: 'drifted', detail: 'fail2ban installed but not running' }
    }
    return { status: 'missing', detail: 'fail2ban not installed' }
  },

  async apply(exec: RemoteExec): Promise<ApplyResult> {
    // Write jail.local via heredoc to avoid quoting issues
    const script = [
      `mkdir -p ${SENTINEL_DIR}`,
      'apt-get install -y -q fail2ban',
      `printf '%s' ${shellQuote(JAIL_CONF)} > /etc/fail2ban/jail.local`,
      'systemctl enable --now fail2ban',
      'systemctl restart fail2ban',
      `touch ${SENTINEL}`,
    ].join(' && ')

    const { code, stderr } = await exec(`sudo sh -c '${script.replace(/'/g, "'\\''")}'`)
    if (code !== 0) {
      throw new Error(`fail2ban setup failed (exit ${code}): ${stderr.slice(0, 200)}`)
    }
    return { changed: true, detail: 'fail2ban installed with SSH jail (maxretry=5, bantime=600s)' }
  },
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}
