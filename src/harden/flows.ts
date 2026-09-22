// The two Tailscale flows that are not a hardening module: moving a stack onto its tailnet
// address, and taking it back off.
//
// They live here rather than in the CLI command because the MCP server runs them too, and an
// agent driving clawops must get the same refusals an operator does — the refusals are the
// feature. Everything here returns a result. Deciding what to print, what to prompt for, and
// what exit code to use belongs to the caller: the CLI throws at its boundary, the MCP server
// elicits and returns text (R15 also forbids a stdio server writing a byte to stdout).

import type { ClawopsContext } from '../cli/context.js'
import type { ClawopsConfig } from '../config/store.js'
import type { ConnectionInfo } from '../providers/types.js'

export type CutoverOutcome =
  | { ok: true; ip: string; hostname?: string; pinned: number; message: string }
  | { ok: false; reason: string }

export type RevertOutcome =
  | { ok: true; publicHost: string; tailnetIp: string; message: string }
  | { ok: false; reason: string; needsReopen: boolean }
  /** Nothing to undo. Not a failure: running revert twice should not read as one. */
  | { ok: true; noop: true; message: string }

/**
 * Point a stack at its tailnet address, but only once that address is proven.
 *
 * The public connection handed in is the one clawops already trusts. The override is written
 * only if a fresh session over the tailnet address succeeds against keys pinned through it. On
 * any failure nothing is written and clawops keeps using the public address, which is the
 * property everything that closes a door afterwards depends on.
 */
export async function cutOverToTailnet(
  ctx: ClawopsContext,
  conn: ConnectionInfo,
  config: ClawopsConfig,
): Promise<CutoverOutcome> {
  const { withRemoteExec } = await import('./index.js')
  const { verifyTailnetAddress, probeSsh } = await import('./tailscale-cutover.js')
  const { setConfig } = await import('../config/store.js')

  const result = await withRemoteExec(conn, undefined, (exec) =>
    verifyTailnetAddress(conn, { exec, probe: (target) => probeSsh(target) }),
  )
  if (!result.ok) return result

  const stack = config.stacks[ctx.stackName]
  if (!stack) {
    return {
      ok: false,
      reason: `Stack "${ctx.stackName}" is not in config, so the tailnet address could not be recorded.`,
    }
  }
  setConfig({
    ...config,
    stacks: {
      ...config.stacks,
      [ctx.stackName]: {
        ...stack,
        tailscale: {
          ip: result.ip,
          ...(result.hostname ? { hostname: result.hostname } : {}),
          verifiedAt: new Date().toISOString(),
        },
      },
    },
  })
  return {
    ok: true,
    ip: result.ip,
    ...(result.hostname ? { hostname: result.hostname } : {}),
    pinned: result.pinned,
    message:
      `clawops now reaches "${ctx.stackName}" at ${result.ip} over the tailnet ` +
      `(${result.pinned} host key${result.pinned === 1 ? '' : 's'} pinned through the public connection). ` +
      'The public address is still open; nothing has been closed.',
  }
}

/**
 * Undo the cutover: leave the tailnet, and point clawops back at the public address.
 *
 * Everything runs over the public address, found by building a context that ignores the
 * override. Leaving the tailnet over the tailnet cuts the connection doing it — on AWS that hung
 * for eight minutes. So the public address has to answer first, and on a private-only stack it
 * does not: the ports are closed, and reopening them is an infrastructure change, which goes
 * through a plan. Revert says so and changes nothing rather than stranding the stack.
 */
export async function revertTailnet(
  ctx: ClawopsContext,
  config: ClawopsConfig,
): Promise<RevertOutcome> {
  const override = config.stacks[ctx.stackName]?.tailscale
  if (!override) {
    return {
      ok: true,
      noop: true,
      message: `Stack "${ctx.stackName}" is not using a tailnet address; nothing to revert.`,
    }
  }

  const { buildContext } = await import('../cli/context.js')
  const { extractBaseOutputs } = await import('../pulumi/outputs.js')
  const { probeSsh, leaveTailnet } = await import('./tailscale-cutover.js')
  const { withRemoteExec } = await import('./index.js')
  const { getConfig, setConfig } = await import('../config/store.js')
  const { forgetHost } = await import('../transport/known-hosts-file.js')

  const direct = buildContext({ stack: ctx.stackName, ignoreTailnet: true })
  const outputMap = await (await direct.getStack()).outputs()
  const raw = Object.fromEntries(Object.entries(outputMap).map(([k, v]) => [k, v.value]))
  const publicConn = direct.adapter.getConnectionInfo({
    ...extractBaseOutputs(raw),
    privateKeyPath: config.ssh.keyPath,
    knownHostsPath: config.ssh.knownHostsPath,
  })

  if (!(await probeSsh(publicConn))) {
    return override.privateOnly
      ? {
          ok: false,
          needsReopen: true,
          reason:
            `"${ctx.stackName}" is private-only: its public ports are closed, so there is no way to ` +
            'leave the tailnet without losing the host. Reopen SSH first, then run this again:\n' +
            `  clawops plan --stack ${ctx.stackName} --ssh-cidr auto --out <abs-path>/plan.json\n` +
            '  clawops apply <abs-path>/plan.json\n' +
            'Nothing was changed.',
        }
      : {
          ok: false,
          needsReopen: false,
          reason:
            `This machine cannot reach "${ctx.stackName}" at its public address ${publicConn.host}, ` +
            'and leaving the tailnet would leave no way in. Nothing was changed.',
        }
  }

  const left = await withRemoteExec(publicConn, undefined, (exec) => leaveTailnet(exec))
  if (!left.ok) {
    return {
      ok: false,
      needsReopen: false,
      reason: `${left.reason}. clawops still uses the tailnet address; nothing else was changed.`,
    }
  }

  // Re-read: the probe and the logout took seconds, and config is the operator's file.
  const fresh = getConfig() ?? config
  const stack = fresh.stacks[ctx.stackName]
  if (stack) {
    const { tailscale: _dropped, ...rest } = stack
    void _dropped
    setConfig({ ...fresh, stacks: { ...fresh.stacks, [ctx.stackName]: rest } })
  }
  forgetHost(expandHome(config.ssh.knownHostsPath), override.ip, publicConn.port)

  return {
    ok: true,
    publicHost: publicConn.host,
    tailnetIp: override.ip,
    message:
      `"${ctx.stackName}" has left the tailnet; clawops reaches it at ${publicConn.host} again ` +
      `(the pinned key for ${override.ip} was forgotten).`,
  }
}

/** The connection the stack's own outputs describe, with the operator's key paths merged in. */
export async function connectionFor(
  ctx: ClawopsContext,
  config: ClawopsConfig,
): Promise<ConnectionInfo> {
  const { extractBaseOutputs } = await import('../pulumi/outputs.js')
  const outputMap = await (await ctx.getStack()).outputs()
  const raw = Object.fromEntries(Object.entries(outputMap).map(([k, v]) => [k, v.value]))
  return ctx.adapter.getConnectionInfo({
    ...extractBaseOutputs(raw),
    privateKeyPath: config.ssh.keyPath,
    knownHostsPath: config.ssh.knownHostsPath,
  })
}

/** `~` in a configured path is the operator's home, not a directory called "~". */
function expandHome(p: string): string {
  return p.replace(/^~/, process.env['HOME'] ?? '~')
}
