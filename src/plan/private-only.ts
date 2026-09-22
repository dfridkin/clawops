// Closing a stack's public ports once it is reachable over its tailnet (WO-34 step 6, ADR 0013).
//
// The spec had `harden --private-only` run a Pulumi update itself. It cannot do that safely:
// clawops keeps no stack config between runs, and every `up` rebuilds it from a plan, so an
// update started from `harden` would run with the programs' defaults — a different instance
// type is a replaced instance. Closing ports is an infrastructure change, and those go through
// a plan the operator reviews (F5–F6). So `--private-only` is a plan flag, and this is the one
// place that decides whether such a plan is safe to make, and safe to apply.
//
// "Safe" is one question asked twice: can this machine reach the host over the tailnet right
// now, through keys pinned against the public connection? Once at plan time, so the operator
// does not review a plan that would lock them out; again at apply time, because the tailnet can
// go away in between and apply is the step that closes the door.

import { UsageError } from '../errors/index.js'
import type { ClawopsContext } from '../cli/context.js'
import type { ConnectionInfo } from '../providers/types.js'
import type { TailscaleOverride } from '../config/store.js'
import type { DeployPlan } from './generate.js'
import type { NetworkFlags, ResolvedNetwork } from './network-args.js'

export type Probe = (conn: ConnectionInfo) => Promise<boolean>

/** The network block of a private-only plan: no public ingress, and the address that remains. */
export function privateOnlyNetwork(
  flags: NetworkFlags,
  resolved: ResolvedNetwork,
  override: TailscaleOverride | undefined,
  stackName: string,
): DeployPlan['spec']['network'] {
  if (flags.sshCidr !== undefined || flags.gatewayCidr !== undefined) {
    throw new UsageError(
      '--private-only closes public SSH and gateway access, so it cannot be combined with ' +
        '--ssh-cidr or --gateway-cidr. Drop those flags, or drop --private-only to keep a public rule.',
    )
  }
  const tailnet = requireOverride(override, stackName)
  return {
    ...resolved,
    allowedSshCidrs: [],
    allowedGatewayCidrs: [],
    tailscale: { enabled: true, privateOnly: true, ip: tailnet.ip },
  }
}

/**
 * Refuse to close anything the tailnet cannot replace. Throws UsageError; this runs at the CLI
 * and apply boundaries, where throwing is how a refusal reaches the operator.
 */
export async function assertTailnetReachable(ctx: ClawopsContext, probe: Probe): Promise<string> {
  const tailnet = requireOverride(ctx.config.stacks[ctx.stackName]?.tailscale, ctx.stackName)

  const { extractBaseOutputs } = await import('../pulumi/outputs.js')
  let conn: ConnectionInfo
  try {
    const outputMap = await (await ctx.getStack()).outputs()
    const raw = Object.fromEntries(Object.entries(outputMap).map(([k, v]) => [k, v.value]))
    // ctx.adapter carries the override, so this is the tailnet address, with the stack's own
    // port and user.
    conn = ctx.adapter.getConnectionInfo({
      ...extractBaseOutputs(raw),
      privateKeyPath: ctx.config.ssh.keyPath,
      knownHostsPath: ctx.config.ssh.knownHostsPath,
    })
  } catch {
    throw new UsageError(
      `Stack "${ctx.stackName}" has no deployment to make private. Deploy it, then run ` +
        '`clawops harden --tailscale`, then plan with --private-only.',
    )
  }

  if (!(await probe(conn))) {
    throw new UsageError(
      `This machine cannot reach "${ctx.stackName}" at its tailnet address ${tailnet.ip}, so ` +
        'closing the public ports would leave no way in. Check that Tailscale is running here and ' +
        'signed in to the same tailnet, then try again. Nothing was changed.',
    )
  }
  return tailnet.ip
}

/**
 * Everything apply checks before a private-only plan touches the cloud. The plan file is JSON
 * an operator can edit, so its claims are re-checked against the stack rather than trusted.
 */
export async function guardPrivateOnlyApply(
  plan: DeployPlan,
  ctx: ClawopsContext,
  probe: Probe,
): Promise<void> {
  const { network } = plan.spec
  if (network.tailscale?.privateOnly !== true) return

  if (network.allowedSshCidrs.length > 0 || network.allowedGatewayCidrs.length > 0) {
    throw new UsageError(
      'This plan is marked private-only but still opens public ports ' +
        `(SSH: ${network.allowedSshCidrs.join(', ') || 'none'}; ` +
        `gateway: ${network.allowedGatewayCidrs.join(', ') || 'none'}). ` +
        'Regenerate it with `clawops plan --private-only`.',
    )
  }

  const override = ctx.config.stacks[ctx.stackName]?.tailscale
  const current = requireOverride(override, ctx.stackName)
  if (network.tailscale.ip !== current.ip) {
    throw new UsageError(
      `This plan was made for the tailnet address ${network.tailscale.ip ?? '(none)'}, but ` +
        `"${ctx.stackName}" is now reached at ${current.ip}. Regenerate it with ` +
        '`clawops plan --private-only`.',
    )
  }

  await assertTailnetReachable(ctx, probe)
}

function requireOverride(
  override: TailscaleOverride | undefined,
  stackName: string,
): TailscaleOverride {
  if (!override) {
    throw new UsageError(
      `Stack "${stackName}" has no verified tailnet address, so closing its public ports would ` +
        'leave no way in. Run `clawops harden --tailscale` first; it only records an address ' +
        'this machine has reached.',
    )
  }
  return override
}
