// UFW firewall module.
// Default deny-incoming, allow SSH, and allow the gateway port ONLY where the gateway is
// actually published to the network.

import type { HardeningModule, RemoteExec, CheckResult, ApplyResult } from '../types.js'
import { SENTINEL_DIR } from '../types.js'
import {
  PUBLISH_INSPECT_CMD, publishForRestart, publishedGatewayPort,
} from '../../openclaw/runtime.js'

const SENTINEL = `${SENTINEL_DIR}/ufw.applied`

/**
 * What the running container publishes, read from the host rather than assumed.
 *
 * `harden` runs after a deployment exists, so the container is the authority on this — more
 * so than the plan, which may have been applied, edited, or superseded. And the module has a
 * RemoteExec already.
 */
async function publishedGateway(
  exec: RemoteExec,
): Promise<{ exposed: boolean; port?: number }> {
  const { stdout } = await exec(`${PUBLISH_INSPECT_CMD} 2>/dev/null || true`)
  if (publishForRestart(stdout) !== 'all') return { exposed: false }
  return { exposed: true, port: publishedGatewayPort(stdout) }
}

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
      // The gateway rule used to be unconditional, on a hardcoded 18789. Since WO-38 the
      // container publishes on 127.0.0.1 by default, so that rule opened a port nothing
      // was listening on — `clawops harden` widening the firewall past what the deployment
      // exposes, which is the opposite of hardening. And a deployment on a non-default
      // port got a rule for the wrong one.
      const gateway = await publishedGateway(exec)
      const rules = [`ufw allow ${sshPort}/tcp comment "clawops SSH"`]
      let gatewayNote: string

      if (!gateway.exposed) {
        gatewayNote = 'gateway port not opened (published on 127.0.0.1 — reach it with `clawops tunnel`)'
      } else if (gateway.port === undefined) {
        // Exposed, but the port could not be read. Opening a guess is worse than opening
        // nothing: it would either be useless or open something unintended.
        gatewayNote =
          'gateway published on every interface but its port could not be read — no rule added; ' +
          'run `clawops doctor --stack <name>` and open it yourself if that is intended'
      } else {
        rules.push(`ufw allow ${gateway.port}/tcp comment "OpenClaw gateway"`)
        gatewayNote = `allow ${gateway.port}/tcp`
      }

      const script = [
        `mkdir -p ${SENTINEL_DIR}`,
        'apt-get install -y -q ufw',
        'ufw --force reset',
        'ufw default deny incoming',
        'ufw default allow outgoing',
        ...rules,
        'ufw --force enable',
        `touch ${SENTINEL}`,
      ].join(' && ')

      const { code, stderr } = await exec(`sudo sh -c '${script.replace(/'/g, "'\\''")}'`)
      if (code !== 0) {
        throw new Error(`UFW setup failed (exit ${code}): ${stderr.slice(0, 200)}`)
      }
      return {
        changed: true,
        detail: `UFW enabled: deny-all in, allow ${sshPort}/tcp; ${gatewayNote}`,
      }
    },
  }
}

export const ufwModule = makeUfwModule()
