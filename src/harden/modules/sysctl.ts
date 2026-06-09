// Kernel sysctl hardening module (opt-in).
// Disables IP forwarding, enables TCP SYN cookies, restricts ICMP redirects.

import type { HardeningModule, RemoteExec, CheckResult, ApplyResult } from '../types.js'
import { SENTINEL_DIR } from '../types.js'

const SENTINEL = `${SENTINEL_DIR}/sysctl.applied`

const SYSCTL_CONF = `# clawops kernel hardening
net.ipv4.ip_forward = 0
net.ipv6.conf.all.forwarding = 0
net.ipv4.tcp_syncookies = 1
net.ipv4.conf.all.accept_redirects = 0
net.ipv6.conf.all.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.conf.default.rp_filter = 1
`

export const sysctlModule: HardeningModule = {
  id: 'sysctl',
  label: 'Kernel sysctl hardening',
  defaultOn: false,
  providers: 'all',

  async check(exec: RemoteExec): Promise<CheckResult> {
    const { stdout: sentinel } = await exec(`test -f ${SENTINEL} && echo yes || echo no`)
    if (sentinel.trim() === 'yes') {
      return { status: 'applied', detail: 'sysctl hardening applied (sentinel present)' }
    }
    const { stdout } = await exec(
      `test -f /etc/sysctl.d/99-clawops-hardening.conf && echo yes || echo no`,
    )
    if (stdout.trim() === 'yes') {
      return { status: 'applied', detail: 'clawops sysctl config already present' }
    }
    return { status: 'missing', detail: 'hardened sysctl settings not configured' }
  },

  async apply(exec: RemoteExec): Promise<ApplyResult> {
    const confEscaped = SYSCTL_CONF.replace(/'/g, "'\\''")
    const script = [
      `mkdir -p ${SENTINEL_DIR}`,
      `printf '%s' '${confEscaped}' > /etc/sysctl.d/99-clawops-hardening.conf`,
      'sysctl --system',
      `touch ${SENTINEL}`,
    ].join(' && ')

    const { code, stderr } = await exec(`sudo sh -c '${script.replace(/'/g, "'\\''")}'`)
    if (code !== 0) {
      throw new Error(`sysctl hardening failed (exit ${code}): ${stderr.slice(0, 200)}`)
    }
    return { changed: true, detail: 'kernel hardening applied (ip_forward=0, syncookies=1, no redirects)' }
  },
}
