// Docker socket hardening — verify /var/run/docker.sock is root:docker 660.

import type { HardeningModule, RemoteExec, CheckResult, ApplyResult } from '../types.js'
import { SENTINEL_DIR } from '../types.js'

const SENTINEL = `${SENTINEL_DIR}/docker-socket.applied`

export const dockerSocketModule: HardeningModule = {
  id: 'docker-socket',
  label: 'Docker socket permissions',
  defaultOn: true,
  providers: 'all',

  async check(exec: RemoteExec): Promise<CheckResult> {
    const { stdout: sentinel } = await exec(`test -f ${SENTINEL} && echo yes || echo no`)
    if (sentinel.trim() === 'yes') {
      // Re-check actual state even with sentinel (permissions can drift)
    }

    const { stdout, code } = await exec(
      `stat -c '%U %G %a' /var/run/docker.sock 2>/dev/null || echo 'not found'`,
    )
    const trimmed = stdout.trim()
    if (trimmed === 'not found' || code !== 0) {
      return { status: 'skipped', detail: 'Docker socket not present (Docker not running?)' }
    }

    const [owner, group, perms] = trimmed.split(' ')
    if (owner === 'root' && group === 'docker' && perms === '660') {
      return { status: 'applied', detail: 'docker.sock is root:docker 660' }
    }
    return {
      status: 'drifted',
      detail: `docker.sock is ${owner}:${group} ${perms} (expected root:docker 660)`,
    }
  },

  async apply(exec: RemoteExec): Promise<ApplyResult> {
    const script = [
      `mkdir -p ${SENTINEL_DIR}`,
      'chown root:docker /var/run/docker.sock',
      'chmod 660 /var/run/docker.sock',
      `touch ${SENTINEL}`,
    ].join(' && ')

    const { code, stderr } = await exec(`sudo sh -c '${script.replace(/'/g, "'\\''")}'`)
    if (code !== 0) {
      throw new Error(`docker socket fix failed (exit ${code}): ${stderr.slice(0, 200)}`)
    }
    return { changed: true, detail: 'docker.sock set to root:docker 660' }
  },
}
