// UFW firewall module.
// Sets default deny-incoming, allows configured SSH + gateway ports, enables ufw.

import type { HardeningModule, RemoteExec, CheckResult, ApplyResult } from '../types.js'
import { SENTINEL_DIR } from '../types.js'

const SENTINEL = `${SENTINEL_DIR}/ufw.applied`
const GATEWAY_PORT = 18789

export function makeUfwModule(sshPort: number = 22): HardeningModule {
  return {
    id: 'ufw',
    label: 'UFW firewall',
    defaultOn: true,
    providers: 'all',

    async check(exec: RemoteExec): Promise<CheckResult> {
      const { stdout: sentinel } = await exec(`test -f ${SENTINEL} && echo yes || echo no`)
      if (sentinel.trim() === 'yes') {
        return { status: 'applied', detail: 'UFW configured (sentinel present)' }
      }
      const { stdout } = await exec(`ufw status 2>/dev/null || echo 'not installed'`)
      if (stdout.includes('Status: active')) {
        return { status: 'applied', detail: 'UFW already active' }
      }
      if (stdout.includes('not installed')) {
        return { status: 'missing', detail: 'UFW not installed' }
      }
      return { status: 'missing', detail: 'UFW installed but not active' }
    },

    async apply(exec: RemoteExec): Promise<ApplyResult> {
      const script = [
        `mkdir -p ${SENTINEL_DIR}`,
        'apt-get install -y -q ufw',
        'ufw --force reset',
        'ufw default deny incoming',
        'ufw default allow outgoing',
        `ufw allow ${sshPort}/tcp comment "clawops SSH"`,
        `ufw allow ${GATEWAY_PORT}/tcp comment "OpenClaw gateway"`,
        'ufw --force enable',
        `touch ${SENTINEL}`,
      ].join(' && ')

      const { code, stderr } = await exec(`sudo sh -c '${script.replace(/'/g, "'\\''")}'`)
      if (code !== 0) {
        throw new Error(`UFW setup failed (exit ${code}): ${stderr.slice(0, 200)}`)
      }
      return { changed: true, detail: `UFW enabled: deny-all in, allow ${sshPort}/tcp + ${GATEWAY_PORT}/tcp` }
    },
  }
}

export const ufwModule = makeUfwModule()
