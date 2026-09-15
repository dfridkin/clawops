// The stack config a plan becomes.
//
// This existed twice and disagreed with itself. `generatePlan` set three keys before running
// its preview; `applyPlan` set six, and neither set `sshPublicKey`, which every cloud program
// requires. So the preview failed on every cloud plan ever generated — reported as one line
// of warning, "diff unavailable" — and the plan→apply path had never created an instance.
//
// The plan is the contract. Both sides of it write stack config the same way, from here, so a
// preview shows what an apply would do and a missing key is a single omission rather than two.

import process from 'node:process'
import { UsageError } from '../errors/index.js'
import { GATEWAY_PORT } from '../openclaw/run-flags.js'
import { getConfig } from '../config/store.js'
import { resolvePublicKey } from './ssh-key.js'
import type { DeployPlan } from './generate.js'

/** The slice of a Pulumi Stack this needs — keeps callers and tests free of the SDK. */
export interface ConfigurableStack {
  setConfig(key: string, value: { value: string }): Promise<void>
}

export async function writeStackConfig(stack: ConfigurableStack, plan: DeployPlan): Promise<void> {
  // The programs refuse to run without this, and apply never set it — so plan→apply had never
  // produced an instance on any provider. Plans generated before the key was recorded fall
  // back to the configured key so they stay applicable.
  const sshPublicKey = plan.spec.ssh?.publicKey ?? fallbackPublicKey()
  if (!sshPublicKey) {
    throw new UsageError(
      'This plan carries no SSH public key, and none could be resolved from ' +
        '`ssh.keyPath` in ~/.clawops/config.json. The instance would have no way to admit ' +
        'anyone. Run `clawops doctor` to see why the key is unusable, then regenerate the plan.',
    )
  }
  await stack.setConfig('sshPublicKey', { value: sshPublicKey })

  await stack.setConfig('instanceType', { value: plan.spec.instanceType })
  if (plan.spec.region) {
    await stack.setConfig('region', { value: plan.spec.region })
  }
  await stack.setConfig('openclawVersion', { value: plan.spec.openclaw.version })
  await stack.setConfig('publishGateway', {
    value: plan.spec.network?.publishGateway ?? 'loopback',
  })
  await stack.setConfig('gatewayPort', {
    value: String(plan.spec.network?.gatewayPort ?? GATEWAY_PORT),
  })

  // The plan's firewall rules, which apply used to validate, print, and then drop on the
  // floor. Every Pulumi program reads these from stack config — `cfg.get('sshCidrs')` and
  // friends — so without them `resolveIngressCidrs` returned an empty list and the stack was
  // created with NO ingress rules at all. Not a weaker rule: none. clawops builds its own
  // VPC, so there is no default rule to fall back on, and the instance was unreachable by
  // SSH — which is every day-two command.
  //
  // `accessMode: restricted` is the deny-all default (N10). The CIDRs decide what opens.
  // Clouds that resolve the account from ambient configuration get it pinned here, so a deploy
  // lands where preflight looked rather than wherever the environment points at the moment
  // `up` runs. Both of these can change between the check and the apply — a `gcloud config set
  // project` or an `az account set` in another terminal is enough.
  if (plan.spec.provider === 'gcp') {
    const { resolveProjectId } = await import('../providers/gcp/preflight.js')
    const project = resolveProjectId()
    if (project) await stack.setConfig('gcp:project', { value: project })
  }

  if (plan.spec.provider === 'azure') {
    const { resolveSubscriptionId } = await import('../providers/azure/cli-auth.js')
    const subscription = resolveSubscriptionId()
    if (subscription) await stack.setConfig('azure-native:subscriptionId', { value: subscription })
  }

  await stack.setConfig('accessMode', { value: 'restricted' })
  await stack.setConfig('sshCidrs', {
    value: (plan.spec.network?.allowedSshCidrs ?? []).join(','),
  })
  await stack.setConfig('gatewayCidrs', {
    value: (plan.spec.network?.allowedGatewayCidrs ?? []).join(','),
  })

  // Enable Bedrock IAM attachment when the plan selects the bedrock provider.
  const modelProvider = (plan.spec.openclaw.config?.['models'] as Record<string, unknown> | undefined)?.['provider']
  if (modelProvider === 'bedrock') {
    await stack.setConfig('bedrockEnabled', { value: 'true' })
  }
}

/** For plans generated before `spec.ssh.publicKey` was recorded. */
function fallbackPublicKey(): string | undefined {
  const config = getConfig()
  if (!config) return undefined
  const keyPath = config.ssh.keyPath.replace(/^~/, process.env['HOME'] ?? '~')
  return resolvePublicKey(keyPath)
}
